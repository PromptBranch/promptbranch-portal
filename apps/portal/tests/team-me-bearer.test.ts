import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getMe, DELETE as deleteMe } from "@/app/api/team/v1/me/route";
import { GET as getPrincipal } from "@/app/api/team/v1/principal/route";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// Negative wall first (plan P2): every invalid token shape, mixed auth modes,
// protocol gating, then the happy path and account deletion.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function teamRequest(
  path: string,
  options: { bearer?: string; cookie?: string; protocol?: boolean; method?: string; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.protocol !== false) headers["x-promptbranch-team-protocol"] = "1";
  return new NextRequest(`http://127.0.0.1:4317/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function errorBody(response: Response): Promise<{ error: { code: string; requestId: string; retryable: boolean } }> {
  return (await response.json()) as { error: { code: string; requestId: string; retryable: boolean } };
}

describe("GET /api/team/v1/me — negative wall", () => {
  it("rejects missing auth with the stable error body", async () => {
    const response = await getMe(teamRequest("me"));
    expect(response.status).toBe(401);
    const body = await errorBody(response);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.error.retryable).toBe("boolean");
  });

  it("requires the protocol header (426 before any domain work)", async () => {
    const token = await setup.signToken(nativeClaims());
    const response = await getMe(teamRequest("me", { bearer: token, protocol: false }));
    expect(response.status).toBe(426);
    expect((await errorBody(response)).error.code).toBe("PROTOCOL_UNSUPPORTED");
  });

  it("rejects wrong audience, wrong issuer, unverified email, missing sid, web azp, ID-typed and expired tokens", async () => {
    const cases = [
      ["wrong audience", nativeClaims({ aud: "other-api" })],
      ["wrong issuer", nativeClaims({ iss: "http://127.0.0.1:48080/realms/evil" })],
      ["unverified email", nativeClaims({ email_verified: false })],
      ["missing sid", nativeClaims({ sid: undefined })],
      ["web client azp", nativeClaims({ azp: "promptbranch-web" })],
      ["id-token typ", nativeClaims(), { typ: "ID" }],
      ["expired", nativeClaims({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ] as const;
    for (const [label, claims, options] of cases) {
      const token = await setup.signToken(claims as Record<string, unknown>, options as { typ?: string } | undefined);
      const response = await getMe(teamRequest("me", { bearer: token }));
      expect(response.status, label).toBe(401);
      expect((await errorBody(response)).error.code, label).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects requests supplying both Bearer and cookie", async () => {
    const token = await setup.signToken(nativeClaims());
    const response = await getMe(teamRequest("me", { bearer: token, cookie: "__Host-pb-team=abc" }));
    expect(response.status).toBe(401);
    expect((await errorBody(response)).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a disabled account even with a valid token", async () => {
    const token = await setup.signToken(nativeClaims());
    expect((await getMe(teamRequest("me", { bearer: token }))).status).toBe(200);
    await setup.pool.query("UPDATE team_users SET disabled_at = now() WHERE normalized_email = 'alice@promptbranch.test'");
    try {
      const response = await getMe(teamRequest("me", { bearer: token }));
      expect(response.status).toBe(401);
      expect((await errorBody(response)).error.code).toBe("UNAUTHENTICATED");
    } finally {
      await setup.pool.query("UPDATE team_users SET disabled_at = NULL WHERE normalized_email = 'alice@promptbranch.test'");
    }
  });
});

describe("GET /api/team/v1/me — happy path", () => {
  it("maps the verified identity once and reuses its session", async () => {
    const token = await setup.signToken(nativeClaims());
    const first = await getMe(teamRequest("me", { bearer: token }));
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      user: { id: string; displayName: string; email: string };
      workspaces: unknown[];
    };
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.user.email).toBe("alice@promptbranch.test");
    expect(body.workspaces).toEqual([]);

    await getMe(teamRequest("me", { bearer: token }));
    const sessions = await setup.pool.query("SELECT count(*)::int AS n FROM team_sessions");
    expect(sessions.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/team/v1/principal", () => {
  it("returns the server-authored human principal identity", async () => {
    const token = await setup.signToken(nativeClaims());
    const response = await getPrincipal(teamRequest("principal", { bearer: token }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; principalId: string; userId: string; agentTokenId: string | null; scopes: unknown[] };
    expect(body.kind).toBe("human");
    expect(body.agentTokenId).toBeNull();
    expect(body.scopes).toEqual([]);
    expect(body.principalId).toBe(`human:${body.userId}`);
  });
});

describe("DELETE /api/team/v1/me", () => {
  it("requires the confirmed email and rejects sole owners", async () => {
    const token = await setup.signToken(nativeClaims({ sub: "owner-sub", email: "owner@promptbranch.test", sid: "owner-sid" }));
    await getMe(teamRequest("me", { bearer: token }));
    const userRow = await setup.pool.query<{ id: string }>("SELECT id FROM team_users WHERE normalized_email = 'owner@promptbranch.test'");
    const ownerId = userRow.rows[0]!.id;
    await setup.pool.query(
      `INSERT INTO team_workspaces (name, server_epoch) VALUES ('Owned', gen_random_uuid()) RETURNING id`,
    );
    const wsRow = await setup.pool.query<{ id: string }>("SELECT id FROM team_workspaces WHERE name = 'Owned'");
    await setup.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'owner', gen_random_uuid())`,
      [wsRow.rows[0]!.id, ownerId],
    );

    const wrong = await deleteMe(
      teamRequest("me", { bearer: token, method: "DELETE", body: { confirmEmail: "wrong@promptbranch.test" } }),
    );
    expect(wrong.status).toBe(422);

    const sole = await deleteMe(
      teamRequest("me", { bearer: token, method: "DELETE", body: { confirmEmail: "owner@promptbranch.test" } }),
    );
    expect(sole.status).toBe(409);
    expect((await errorBody(sole)).error.code).toBe("LAST_OWNER");
  });

  it("deletes a member with no sole-owned workspace and kills their sessions", async () => {
    const token = await setup.signToken(nativeClaims({ sub: "plain-sub", email: "plain@promptbranch.test", sid: "plain-sid" }));
    const before = await getMe(teamRequest("me", { bearer: token }));
    expect(before.status).toBe(200);

    const response = await deleteMe(
      teamRequest("me", { bearer: token, method: "DELETE", body: { confirmEmail: "plain@promptbranch.test" } }),
    );
    expect(response.status).toBe(200);
    await expect((await getMe(teamRequest("me", { bearer: token }))).status).toBe(401);
  });
});
