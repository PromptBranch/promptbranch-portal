import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listWorkspacesRoute, POST as createWorkspaceRoute } from "@/app/api/team/v1/workspaces/route";
import { GET as getWorkspaceRoute } from "@/app/api/team/v1/workspaces/[w]/route";
import { GET as membersRoute } from "@/app/api/team/v1/workspaces/[w]/members/route";
import { GET as invitationsRoute } from "@/app/api/team/v1/workspaces/[w]/invitations/route";
import { GET as auditRoute } from "@/app/api/team/v1/workspaces/[w]/audit/route";
import { POST as commandsRoute } from "@/app/api/team/v1/workspaces/[w]/commands/route";
import { POST as acceptRoute } from "@/app/api/team/v1/invitations/accept/route";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P3 over real HTTP handlers: workspace creation + idempotent replay, the
// server-side role matrix on every read surface, foreign-workspace 403/404
// semantics, command dispatch (epoch header, receipts, CSRF for cookies)
// and the invitation create → email job → accept flow.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function request(
  path: string,
  options: {
    bearer?: string;
    method?: string;
    body?: unknown;
    epoch?: string;
    csrf?: string;
    origin?: string;
    protocol?: boolean;
  } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.epoch) headers["x-promptbranch-team-epoch"] = options.epoch;
  if (options.csrf) headers["x-pb-team-csrf"] = options.csrf;
  if (options.origin) headers.origin = options.origin;
  if (options.protocol === false) delete headers["x-promptbranch-team-protocol"];
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function bearerFor(claims: Record<string, unknown>): Promise<string> {
  return setup.signToken(nativeClaims(claims));
}

interface WorkspaceDto {
  id: string;
  name: string;
  role: string;
  membershipGeneration: string;
  serverEpoch: string;
  entityVersion: number;
  updatedAt: string;
}

async function createWorkspace(name: string, sub = "alice-sub", sid = "provider-sid-alice"): Promise<WorkspaceDto> {
  const bearer = await bearerFor({ sub, sid });
  const response = await createWorkspaceRoute(
    request("workspaces", { bearer, method: "POST", body: { commandId: randomUUID(), name } }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).workspace as WorkspaceDto;
}

describe("workspace routes", () => {
  it("creates idempotently and lists memberships", async () => {
    const commandId = randomUUID();
    const bearer = await bearerFor({});
    const first = await createWorkspaceRoute(
      request("workspaces", { bearer, method: "POST", body: { commandId, name: "HTTP WS" } }),
    );
    expect(first.status).toBe(201);
    const second = await createWorkspaceRoute(
      request("workspaces", { bearer, method: "POST", body: { commandId, name: "HTTP WS" } }),
    );
    expect(second.status).toBe(200);
    expect((await second.json()).workspace.id).toBe((await first.json()).workspace.id);

    const list = await listWorkspacesRoute(request("workspaces", { bearer }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: WorkspaceDto[] };
    expect(body.items.some((w) => w.name === "HTTP WS")).toBe(true);
  });

  it("serves fresh reads to members, generic 403 to nonmembers, 404 for unknown ids", async () => {
    const w = await createWorkspace("Fresh HTTP");
    const member = await bearerFor({ sub: "member-sub", sid: "member-sid" });
    await setup.pool.query(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', 'member-sub', 'x@promptbranch.test', 'x@promptbranch.test', 'X')`,
    );
    const outsider = await bearerFor({ sub: "outsider-sub", sid: "outsider-sid" });

    const owner = await bearerFor({});
    expect((await getWorkspaceRoute(request(`workspaces/${w.id}`, { bearer: owner }), { params: Promise.resolve({ w: w.id }) })).status).toBe(200);
    const foreign = await getWorkspaceRoute(request(`workspaces/${w.id}`, { bearer: outsider }), {
      params: Promise.resolve({ w: w.id }),
    });
    expect(foreign.status).toBe(403);
    const foreignBody = (await foreign.json()) as { error: { code: string } };
    expect(foreignBody.error.code).toBe("WORKSPACE_FORBIDDEN");
    // The 403 body carries no workspace metadata.
    expect(JSON.stringify(foreignBody)).not.toContain("Fresh HTTP");
    const missing = await getWorkspaceRoute(request(`workspaces/${randomUUID()}`, { bearer: owner }), {
      params: Promise.resolve({ w: randomUUID() }),
    });
    expect(missing.status).toBe(404);
    void member;
  });

  it("guards owner-only reads (members, invitations, audit) by role", async () => {
    const w = await createWorkspace("Owner Only");
    const viewer = await bearerFor({ sub: "viewer-sub", sid: "viewer-sid" });
    const viewerRow = await setup.pool.query<{ id: string }>(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', 'viewer-sub', 'v@promptbranch.test', 'v@promptbranch.test', 'V')
       RETURNING id`,
    );
    await setup.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
       VALUES ($1, $2, 'viewer', gen_random_uuid())`,
      [w.id, viewerRow.rows[0]!.id],
    );

    for (const route of [membersRoute, invitationsRoute, auditRoute]) {
      const response = await route(request(`workspaces/${w.id}/x`, { bearer: viewer }), {
        params: Promise.resolve({ w: w.id }),
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ROLE_FORBIDDEN");
    }
    const owner = await bearerFor({});
    const members = await membersRoute(request(`workspaces/${w.id}/members`, { bearer: owner }), {
      params: Promise.resolve({ w: w.id }),
    });
    expect(members.status).toBe(200);
    expect(((await members.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
  });
});

describe("command dispatch over HTTP", () => {
  it("requires the epoch header and replays receipts idempotently", async () => {
    const w = await createWorkspace("Commands WS");
    const bearer = await bearerFor({});
    const envelope = {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "workspace.rename", name: "Commands renamed", expectedEntityVersion: w.entityVersion },
    };

    const noEpoch = await commandsRoute(request(`workspaces/${w.id}/commands`, { bearer, method: "POST", body: envelope }), {
      params: Promise.resolve({ w: w.id }),
    });
    expect(noEpoch.status).toBe(422);

    const first = await commandsRoute(
      request(`workspaces/${w.id}/commands`, { bearer, method: "POST", body: envelope, epoch: w.serverEpoch }),
      { params: Promise.resolve({ w: w.id }) },
    );
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as { commandId: string; catalogSeq: string; result: { kind: string } };
    expect(receipt.result.kind).toBe("workspace");
    expect(receipt.catalogSeq).toBe("0");

    const replay = await commandsRoute(
      request(`workspaces/${w.id}/commands`, { bearer, method: "POST", body: envelope, epoch: w.serverEpoch }),
      { params: Promise.resolve({ w: w.id }) },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);

    const reused = await commandsRoute(
      request(`workspaces/${w.id}/commands`, {
        bearer,
        method: "POST",
        body: { ...envelope, operation: { ...envelope.operation, name: "DIFFERENT" } },
        epoch: w.serverEpoch,
      }),
      { params: Promise.resolve({ w: w.id }) },
    );
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as { error: { code: string } }).error.code).toBe("COMMAND_ID_REUSED");
  });
});

describe("invitation flow over HTTP", () => {
  it("create → email job → accept, with the token only in the email path", async () => {
    const w = await createWorkspace("Invite HTTP");
    const owner = await bearerFor({});
    const casey = await bearerFor({ sub: "casey-sub", sid: "casey-sid", email: "casey@promptbranch.test" });

    // The HTTP route enqueues the email job and returns no raw token.
    const create = await commandsRoute(
      request(`workspaces/${w.id}/commands`, {
        bearer: owner,
        method: "POST",
        body: {
          commandId: randomUUID(),
          membershipGeneration: w.membershipGeneration,
          operation: { type: "invitation.create", email: "casey@promptbranch.test", role: "contributor" },
        },
        epoch: w.serverEpoch,
      }),
      { params: Promise.resolve({ w: w.id }) },
    );
    expect(create.status).toBe(200);
    expect(JSON.stringify(await create.json())).not.toContain("invitationToken");
    const jobs = await setup.pool.query("SELECT count(*)::int AS n FROM team_jobs WHERE type = 'invitation.email' AND workspace_id = $1", [w.id]);
    expect(jobs.rows[0].n).toBe(1); // email queued transactionally

    // A second invitation through the service layer captures its raw token
    // to drive the HTTP acceptance (the raw value is email-only by design).
    const { executeTeamCommand, SecretBox } = await import("@promptbranch/team-server");
    const secretBox = SecretBox.fromBase64(process.env.TEAM_SESSION_ENCRYPTION_KEY!);
    const ownerId = (await setup.pool.query<{ id: string }>("SELECT id FROM team_users WHERE normalized_email = 'alice@promptbranch.test'")).rows[0]!.id;
    const receipt = await executeTeamCommand(
      { pool: setup.pool, secretBox, publicOrigin: TEST_ORIGIN },
      { kind: "human", userId: ownerId, sessionId: "test-session", authenticatedAt: new Date().toISOString() },
      w.id,
      w.serverEpoch,
      {
        commandId: randomUUID(),
        membershipGeneration: w.membershipGeneration,
        operation: { type: "invitation.create", email: "casey@promptbranch.test", role: "maintainer" },
      },
    );
    expect(receipt.invitationToken).toBeTypeOf("string");

    const accept = await acceptRoute(
      request("invitations/accept", { bearer: casey, method: "POST", body: { commandId: randomUUID(), token: receipt.invitationToken } }),
    );
    expect(accept.status).toBe(200);
    const accepted = (await accept.json()) as { workspace: WorkspaceDto };
    expect(accepted.workspace.role).toBe("maintainer");
    expect(accepted.workspace.id).toBe(w.id);

    // Owner-only surfaces now show Casey in the invited role.
    const members = await membersRoute(request(`workspaces/${w.id}/members`, { bearer: owner }), {
      params: Promise.resolve({ w: w.id }),
    });
    const items = ((await members.json()) as { items: { email: string; role: string }[] }).items;
    expect(items.find((m) => m.email === "casey@promptbranch.test")?.role).toBe("maintainer");
  });
});
