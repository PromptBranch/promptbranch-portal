import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { enterRecovery, finishRecoveryWithRoster, verifyExportRecord } from "@promptbranch/team-server";
import { GET as healthRoute } from "@/app/api/team/v1/health/ready/route";
import { POST as startExportRoute } from "@/app/api/team/v1/workspaces/[w]/export/route";
import { GET as exportPageRoute } from "@/app/api/team/v1/workspaces/[w]/export/[id]/route";
import { POST as commandsRoute } from "@/app/api/team/v1/workspaces/[w]/commands/route";
import { resetTeamServiceCache } from "@/lib/team/service";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P9 over HTTP handlers: the recovery gate (503 while TEAM_RECOVERY_MODE=1,
// 401 for pre-restore tokens after the window closes), the minimal health
// endpoint, and the owner export stream routes.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  process.env.TEAM_RECOVERY_MODE = undefined;
  resetTeamServiceCache();
  await setup.cleanup();
});

function request(
  path: string,
  options: { bearer?: string; method?: string; body?: unknown; epoch?: string; query?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.epoch) headers["x-promptbranch-team-epoch"] = options.epoch;
  const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
  const init = { method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) };
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}${query}`, init);
}

async function bearerFor(claims: Record<string, unknown>): Promise<string> {
  return setup.signToken(nativeClaims(claims));
}

interface WorkspaceDto {
  id: string;
  name: string;
  serverEpoch: string;
  membershipGeneration: string;
  entityVersion: number;
}

async function createWorkspace(name: string, bearer: string): Promise<WorkspaceDto> {
  const response = await (await import("@/app/api/team/v1/workspaces/route")).POST(
    request("workspaces", { bearer, method: "POST", body: { commandId: randomUUID(), name } }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { workspace: WorkspaceDto }).workspace;
}

describe("health/ready", () => {
  it("reports ok with a reachable database and minimal state only", async () => {
    const response = await healthRoute(request("health/ready"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ready: boolean };
    expect(body).toEqual({ ready: true });
    expect(JSON.stringify(body)).not.toMatch(/postgres|postgresql|password|@|%|:\d{4}/);
  });

  it("reports disabled when the team feature is off, without touching the database", async () => {
    process.env.TEAM_ENABLED = "false";
    resetTeamServiceCache();
    try {
      const response = await healthRoute(request("health/ready"));
      // C2: disabled team feature is a plain not-ready; no state vocabulary.
      expect(response.status).toBe(503);
      expect(((await response.json()) as { ready: boolean }).ready).toBe(false);
    } finally {
      process.env.TEAM_ENABLED = undefined;
      resetTeamServiceCache();
    }
  });
});

describe("recovery gate", () => {
  it("refuses ordinary team traffic 503 while TEAM_RECOVERY_MODE=1; pre-restore tokens 401 after the window closes", async () => {
    const owner = await bearerFor({ sub: "recovery-gate-sub", sid: "recovery-gate-sid", email: "recovery-gate@promptbranch.test" });
    const ws = await createWorkspace("Recovery Gate WS", owner);

    // Pre-restore token, issued before the recovery window opens.
    const withPreRestoreToken = () =>
      commandsRoute(
        request(`workspaces/${ws.id}/commands`, {
          bearer: owner,
          method: "POST",
          epoch: ws.serverEpoch,
          body: null,
        }),
        { params: Promise.resolve({ w: ws.id }) },
      );

    process.env.TEAM_RECOVERY_MODE = "1";
    resetTeamServiceCache();
    try {
      const refused = await withPreRestoreToken();
      expect(refused.status).toBe(503);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("UNAVAILABLE");
      const health = await healthRoute(request("health/ready"));
      expect(health.status).toBe(503);
      expect(((await health.json()) as { ready: boolean }).ready).toBe(false);
    } finally {
      process.env.TEAM_RECOVERY_MODE = undefined;
    }

    // The operator runs the runbook against the database (simulated
    // in-process): restore + enterRecovery + roster reconciliation.
    await enterRecovery(setup.pool, { restoredFrom: "gate.test" });
    const memberRow = await setup.pool.query<{ user_id: string }>(
      "SELECT user_id FROM team_memberships WHERE workspace_id = $1 LIMIT 1",
      [ws.id],
    );
    const memberEmail = (await setup.pool.query<{ verified_email: string }>("SELECT verified_email FROM team_users WHERE id = $1", [
      memberRow.rows[0]!.user_id,
    ])).rows[0]!.verified_email;
    await finishRecoveryWithRoster(setup.pool, { rosterEmails: [memberEmail] });

    // Flag cleared: the service returns, but the pre-restore session was
    // revoked with the old world — the stale epoch header rejects it.
    resetTeamServiceCache();
    const after = await withPreRestoreToken();
    expect([401, 410]).toContain(after.status);
  });
});

describe("owner export over HTTP", () => {
  it("serves a verifiable NDJSON stream to the owner only", async () => {
    const owner = await bearerFor({ sub: "export-http-sub", sid: "export-http-sid", email: "export-http@promptbranch.test" });
    const viewer = await bearerFor({ sub: "export-viewer-sub", sid: "export-viewer-sid", email: "export-viewer@promptbranch.test" });
    const ws = await createWorkspace("Export HTTP WS", owner);

    // Seed one approved prompt through the command path.
    const seeded = await commandsRoute(
      request(`workspaces/${ws.id}/commands`, {
        bearer: owner,
        method: "POST",
        epoch: ws.serverEpoch,
        body: {
          commandId: randomUUID(),
          membershipGeneration: ws.membershipGeneration,
          operation: {
            type: "prompt.create",
            title: "HTTP export prompt",
            description: "",
            content: "http export canary",
            tagIds: [],
            collectionIds: [],
            changeNote: "",
          },
        },
      }),
      { params: Promise.resolve({ w: ws.id }) },
    );
    expect(seeded.status).toBe(200);

    // Non-owners never start an export.
    await setup.pool.query(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', 'export-viewer-sub', 'export-viewer@promptbranch.test', 'export-viewer@promptbranch.test', 'V')
       ON CONFLICT (issuer, subject) DO NOTHING`,
    );
    const viewerRow = await setup.pool.query<{ id: string }>("SELECT id FROM team_users WHERE subject = 'export-viewer-sub'");
    await setup.pool.query("INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'viewer', gen_random_uuid())", [
      ws.id,
      viewerRow.rows[0]!.id,
    ]);
    const denied = await startExportRoute(request(`workspaces/${ws.id}/export`, { bearer: viewer, method: "POST", body: {} }), {
      params: Promise.resolve({ w: ws.id }),
    });
    expect(denied.status).toBe(403);

    // Owner starts the export and walks every NDJSON page.
    const started = await startExportRoute(request(`workspaces/${ws.id}/export`, { bearer: owner, method: "POST", body: {} }), {
      params: Promise.resolve({ w: ws.id }),
    });
    expect(started.status).toBe(201);
    const start = (await started.json()) as { exportId: string; manifest: { counts: Record<string, number> }; expiresAt: string };
    expect(start.manifest.counts.prompt).toBe(1);

    const lines: string[] = [];
    let pageQuery: Record<string, string> | undefined;
    for (;;) {
      const page = await exportPageRoute(request(`workspaces/${ws.id}/export/${start.exportId}`, { bearer: owner, query: pageQuery }), {
        params: Promise.resolve({ w: ws.id, id: start.exportId }),
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("application/x-ndjson");
      expect(page.headers.get("cache-control")).toBe("private, no-store");
      const text = await page.text();
      for (const line of text.split("\n").filter(Boolean)) {
        expect(verifyExportRecord(line)).toBe(true);
        lines.push(line);
      }
      const next = page.headers.get("x-pb-team-export-next-page");
      if (!next) break;
      pageQuery = { page: next };
    }
    expect(lines.length).toBe(Object.values(start.manifest.counts).reduce((a, b) => a + b, 0));
    expect(lines.join("\n")).toContain("http export canary");

    // A member who loses ownership mid-download is cut off on the next page.
    await setup.pool.query("UPDATE team_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [
      ws.id,
      (await setup.pool.query<{ id: string }>("SELECT id FROM team_users WHERE subject = 'export-http-sub'")).rows[0]!.id,
    ]);
    const cutOff = await exportPageRoute(request(`workspaces/${ws.id}/export/${start.exportId}`, { bearer: owner }), {
      params: Promise.resolve({ w: ws.id, id: start.exportId }),
    });
    expect(cutOff.status).toBe(403);
  });
});
