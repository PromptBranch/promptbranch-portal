import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listTokensRoute, POST as createTokenRoute } from "@/app/api/team/v1/workspaces/[w]/agent-tokens/route";
import { DELETE as deleteTokenRoute } from "@/app/api/team/v1/workspaces/[w]/agent-tokens/[id]/route";
import { GET as activityRoute } from "@/app/api/team/v1/workspaces/[w]/activity-items/route";
import { GET as principalRoute } from "@/app/api/team/v1/principal/route";
import { GET as meRoute } from "@/app/api/team/v1/me/route";
import { GET as membersRoute } from "@/app/api/team/v1/workspaces/[w]/members/route";
import { GET as promptsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/route";
import { setupTeamTest, nativeClaims, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P6 over HTTP: token mint/replay/revoke, agent bearer identity on
// /principal, the human-only surfaces, agent catalogue reads, and the
// activity visibility rules.

let setup: TeamTestSetup;

beforeAll(async () => {
  setup = await setupTeamTest();
});

afterAll(async () => {
  await setup.cleanup();
});

function request(path: string, options: { bearer?: string; cookie?: string; method?: string; body?: unknown } = {}): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.cookie) headers.cookie = options.cookie;
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("agent tokens over HTTP", () => {
  it("mints once, replays without the secret, lists metadata and revokes", async () => {
    const owner = await setup.signToken(nativeClaims({}));
    const create = await (
      await import("@/app/api/team/v1/workspaces/route")
    ).POST(
      new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces`, {
        method: "POST",
        headers: { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${owner}` },
        body: JSON.stringify({ commandId: randomUUID(), name: "Agents HTTP WS" }),
      }),
    );
    const workspace = ((await create.json()) as { workspace: { id: string } }).workspace;
    const w = workspace.id;

    const commandId = randomUUID();
    const body = { commandId, name: "http agent", scopes: ["proposal:write"] };
    const first = await createTokenRoute(request(`workspaces/${w}/agent-tokens`, { bearer: owner, method: "POST", body }), {
      params: Promise.resolve({ w }),
    });
    expect(first.status).toBe(201);
    const minted = (await first.json()) as { id: string; token: string; secretAvailable: boolean; expiresAt: string };
    expect(minted.token).toMatch(/^pbt_/);
    expect(minted.secretAvailable).toBe(true);

    const replay = await createTokenRoute(request(`workspaces/${w}/agent-tokens`, { bearer: owner, method: "POST", body }), {
      params: Promise.resolve({ w }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { id: string; token?: string; secretAvailable: boolean };
    expect(replayBody.id).toBe(minted.id);
    expect(replayBody.secretAvailable).toBe(false);
    expect(replayBody.token).toBeUndefined();

    const list = await listTokensRoute(request(`workspaces/${w}/agent-tokens`, { bearer: owner }), { params: Promise.resolve({ w }) });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: { id: string; name: string }[] }).items;
    expect(items.some((t) => t.id === minted.id)).toBe(true);

    // Agent bearer identity on /principal; /me stays human-only.
    const agent = minted.token;
    const principal = await principalRoute(request("principal", { bearer: agent }));
    expect(principal.status).toBe(200);
    const principalBody = (await principal.json()) as { kind: string; principalId: string; userId: string; agentTokenId: string | null; scopes: string[] };
    expect(principalBody.kind).toBe("agent");
    expect(principalBody.agentTokenId).toBe(minted.id);
    expect(principalBody.principalId).toBe(`agent:${minted.id}`);
    expect(principalBody.scopes).toEqual(["catalog:read", "proposal:write"]);

    const me = await meRoute(request("me", { bearer: agent }));
    expect(me.status).toBe(401);

    // Mixed cookie + agent bearer is rejected.
    const mixed = await principalRoute(request("principal", { bearer: agent, cookie: "__Host-pb-team=x" }));
    expect(mixed.status).toBe(401);

    // Agent reads the catalogue (catalog:read implied) but not owner surfaces.
    const prompts = await promptsRoute(request(`workspaces/${w}/prompts`, { bearer: agent }), { params: Promise.resolve({ w }) });
    expect(prompts.status).toBe(200);
    const members = await membersRoute(request(`workspaces/${w}/members`, { bearer: agent }), { params: Promise.resolve({ w }) });
    expect(members.status).toBe(403);

    // A revoked token loses everything immediately.
    const revoke = await deleteTokenRoute(request(`workspaces/${w}/agent-tokens/${minted.id}`, { bearer: owner, method: "DELETE" }), {
      params: Promise.resolve({ w, id: minted.id }),
    });
    expect(revoke.status).toBe(200);
    const after = await principalRoute(request("principal", { bearer: agent }));
    expect(after.status).toBe(401);
  });

  it("activity-items: contributor humans yes, viewers no, promptId required", async () => {
    const owner = await setup.signToken(nativeClaims({ sub: "act-owner-sub", sid: "act-owner-sid" }));
    const create = await (
      await import("@/app/api/team/v1/workspaces/route")
    ).POST(
      new NextRequest(`${TEST_ORIGIN}/api/team/v1/workspaces`, {
        method: "POST",
        headers: { "x-promptbranch-team-protocol": "1", authorization: `Bearer ${owner}` },
        body: JSON.stringify({ commandId: randomUUID(), name: "Activity HTTP WS" }),
      }),
    );
    const w = ((await create.json()) as { workspace: { id: string } }).workspace.id;

    const noPrompt = await activityRoute(request(`workspaces/${w}/activity-items`, { bearer: owner }), { params: Promise.resolve({ w }) });
    expect(noPrompt.status).toBe(422);

    const viewerToken = await setup.signToken(nativeClaims({ sub: "act-viewer-sub", sid: "act-viewer-sid" }));
    const viewerRow = await setup.pool.query<{ id: string }>(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', 'act-viewer-sub', 'v@promptbranch.test', 'v@promptbranch.test', 'V') RETURNING id`,
    );
    await setup.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'viewer', gen_random_uuid())`,
      [w, viewerRow.rows[0]!.id],
    );
    const viewerRead = await activityRoute(request(`workspaces/${w}/activity-items?promptId=${randomUUID()}`, { bearer: viewerToken }), {
      params: Promise.resolve({ w }),
    });
    expect(viewerRead.status).toBe(403);
    expect(((await viewerRead.json()) as { error: { code: string } }).error.code).toBe("ROLE_FORBIDDEN");

    const ownerRead = await activityRoute(request(`workspaces/${w}/activity-items?promptId=${randomUUID()}`, { bearer: owner }), {
      params: Promise.resolve({ w }),
    });
    expect(ownerRead.status).toBe(200);
  });
});
