import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as workspaceDetailRoute } from "@/app/api/team/v1/workspaces/[w]/route";
import { POST as createWorkspaceRoute } from "@/app/api/team/v1/workspaces/route";
import { GET as membersRoute } from "@/app/api/team/v1/workspaces/[w]/members/route";
import { GET as invitationsRoute } from "@/app/api/team/v1/workspaces/[w]/invitations/route";
import { GET as auditRoute } from "@/app/api/team/v1/workspaces/[w]/audit/route";
import { GET as promptsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/route";
import { GET as promptDetailRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/route";
import { GET as revisionsRoute } from "@/app/api/team/v1/workspaces/[w]/prompts/[p]/revisions/route";
import { GET as revisionDetailRoute } from "@/app/api/team/v1/workspaces/[w]/revisions/[r]/route";
import { GET as tagsRoute } from "@/app/api/team/v1/workspaces/[w]/tags/route";
import { GET as collectionsRoute } from "@/app/api/team/v1/workspaces/[w]/collections/route";
import { GET as proposalsRoute } from "@/app/api/team/v1/workspaces/[w]/proposals/route";
import { GET as proposalDetailRoute } from "@/app/api/team/v1/workspaces/[w]/proposals/[p]/route";
import { GET as activityRoute } from "@/app/api/team/v1/workspaces/[w]/activity-items/route";
import { GET as changesRoute } from "@/app/api/team/v1/workspaces/[w]/changes/route";
import { POST as bootstrapRoute } from "@/app/api/team/v1/workspaces/[w]/bootstrap/route";
import { GET as bootstrapPageRoute } from "@/app/api/team/v1/workspaces/[w]/bootstrap/[s]/route";
import { POST as commandsRoute } from "@/app/api/team/v1/workspaces/[w]/commands/route";
import { POST as mintTokenRoute } from "@/app/api/team/v1/workspaces/[w]/agent-tokens/route";
import { default as sitemapFn } from "@/app/sitemap";
import { default as robotsFn } from "@/app/robots";
import { GET as llmsRoute } from "@/app/llms.txt/route";
import { metadata as teamLayoutMetadata } from "@/app/team/layout";
import { setupTeamTest, nativeClaims, TEST_ISSUER, TEST_ORIGIN, type TeamTestSetup } from "./team-test-setup";

// P8 boundaries: the full role × route × foreign-ID authorization matrix,
// spoofed-actor and stale-artifact negatives, response hygiene (no-store,
// no cross-workspace leaks in any status body), the shared write quota,
// the streaming body cap, and private-surface crawl exclusion.

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
    rawBody?: ReadableStream<Uint8Array>;
    query?: Record<string, string>;
  } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-promptbranch-team-protocol": "1" };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.epoch) headers["x-promptbranch-team-epoch"] = options.epoch;
  const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
  const method = options.method ?? "GET";
  // Object literals only (no DOM RequestInit typing): Next's RequestInit
  // differs on optional-null fields like signal. Stream bodies need Node's
  // duplex:"half", which the lib types omit.
  const init = options.rawBody
    ? { method, headers, body: options.rawBody, duplex: "half" as const }
    : { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) };
  return new NextRequest(`${TEST_ORIGIN}/api/team/v1/${path}${query}`, init);
}

interface Human {
  id: string;
  bearer: string;
}

async function human(name: string): Promise<Human> {
  const sub = `${name}-sub`;
  const email = `${name}@promptbranch.test`;
  const inserted = await setup.pool.query<{ id: string }>(
    `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (issuer, subject) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [TEST_ISSUER, sub, email, name],
  );
  return { id: inserted.rows[0]!.id, bearer: await setup.signToken(nativeClaims({ sub, sid: `sid-${name}`, email })) };
}

async function addMember(workspaceId: string, userId: string, role: string): Promise<void> {
  await setup.pool.query(
    "INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, gen_random_uuid())",
    [workspaceId, userId, role],
  );
}

async function generationOf(workspaceId: string, userId: string): Promise<string> {
  return (await setup.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [workspaceId, userId],
  )).rows[0]!.generation;
}

async function promptVersion(workspaceId: string, promptId: string): Promise<number> {
  return (await setup.pool.query<{ entity_version: number }>(
    "SELECT entity_version FROM team_prompts WHERE workspace_id = $1 AND id = $2",
    [workspaceId, promptId],
  )).rows[0]!.entity_version;
}

interface WorkspaceDto {
  id: string;
  name: string;
  serverEpoch: string;
  membershipGeneration: string;
  entityVersion: number;
}

async function createWorkspace(name: string, bearer: string): Promise<WorkspaceDto> {
  const response = await createWorkspaceRoute(request("workspaces", { bearer, method: "POST", body: { commandId: randomUUID(), name } }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { workspace: WorkspaceDto }).workspace;
}

async function seedPrompt(workspace: WorkspaceDto, bearer: string, title: string, content: string): Promise<{ promptId: string; revisionId: string }> {
  const response = await commandsRoute(
    request(`workspaces/${workspace.id}/commands`, {
      bearer,
      method: "POST",
      epoch: workspace.serverEpoch,
      body: {
        commandId: randomUUID(),
        membershipGeneration: workspace.membershipGeneration,
        operation: { type: "prompt.create", title, description: "boundaries fixture", content, tagIds: [], collectionIds: [], changeNote: "seed" },
      },
    }),
    { params: Promise.resolve({ w: workspace.id }) },
  );
  expect(response.status).toBe(200);
  const promptId = ((await response.json()) as { result: { id: string } }).result.id;
  const revision = await setup.pool.query<{ id: string }>(
    "SELECT id FROM team_revisions WHERE workspace_id = $1 AND prompt_id = $2 ORDER BY created_at DESC LIMIT 1",
    [workspace.id, promptId],
  );
  return { promptId, revisionId: revision.rows[0]!.id };
}

// Two workspaces with the SAME title and each side's canary content: any
// status body that ever carries the other side's marker is a leak.
const MARKER_W1 = `W1-CANARY-${randomUUID()}`;
const MARKER_W2 = `W2-CANARY-${randomUUID()}`;
const SHARED_TITLE = "Boundary Twins";

interface Fixture {
  w1: WorkspaceDto;
  w2: WorkspaceDto;
  alice: Human;
  bob: Human;
  carol: Human;
  dana: Human;
  erin: Human;
  gavin: Human;
  heather: Human;
  agentBearer: string;
  agentOwnerId: string;
  promptW1: string;
  revisionW1: string;
  promptW2: string;
  revisionW2: string;
}

let f: Fixture;

beforeAll(async () => {
  const alice = await human("matrix-alice");
  const bob = await human("matrix-bob");
  const w1 = await createWorkspace(SHARED_TITLE, alice.bearer);
  const w2 = await createWorkspace(SHARED_TITLE, bob.bearer);

  const carol = await human("matrix-carol");
  const dana = await human("matrix-dana");
  const erin = await human("matrix-erin");
  const gavin = await human("matrix-gavin");
  const heather = await human("matrix-heather");
  for (const [who, role] of [
    [carol, "maintainer"],
    [dana, "contributor"],
    [erin, "viewer"],
  ] as const) {
    await addMember(w1.id, who.id, role);
  }

  const seeded1 = await seedPrompt(w1, alice.bearer, "W1 prompt", MARKER_W1);
  const seeded2 = await seedPrompt(w2, bob.bearer, "W2 prompt", MARKER_W2);

  // A maintainer-owned agent token with read + proposal scopes.
  const minted = await mintTokenRoute(
    request(`workspaces/${w1.id}/agent-tokens`, {
      bearer: carol.bearer,
      method: "POST",
      body: { commandId: randomUUID(), name: "matrix agent", scopes: ["catalog:read", "proposal:write"] },
    }),
    { params: Promise.resolve({ w: w1.id }) },
  );
  expect(minted.status).toBe(201);
  const agentBearer = ((await minted.json()) as { token: string }).token;

  f = {
    w1,
    w2,
    alice,
    bob,
    carol,
    dana,
    erin,
    gavin,
    heather,
    agentBearer,
    agentOwnerId: carol.id,
    promptW1: seeded1.promptId,
    revisionW1: seeded1.revisionId,
    promptW2: seeded2.promptId,
    revisionW2: seeded2.revisionId,
  };
});

async function bodyText(response: Response): Promise<string> {
  return JSON.stringify(await response.json());
}

/** Denied bodies carry neither side's content. */
function expectNoLeak(text: string, via: string): void {
  expect(text, `${via} leaked workspace content`).not.toContain(MARKER_W1);
  expect(text, `${via} leaked workspace content`).not.toContain(MARKER_W2);
}

/** Allowed W1 reads may carry W1's content but never W2's. */
function expectNoCrossLeak(text: string, via: string): void {
  expect(text, `${via} leaked the other workspace's content`).not.toContain(MARKER_W2);
}

type Role = "none" | "foreign" | "viewer" | "contributor" | "maintainer" | "owner" | "agent";

const ROLE_RANK: Record<string, number> = { viewer: 1, contributor: 2, maintainer: 3, owner: 4 };

interface RouteContext {
  w1: string;
  promptW1: string;
  revisionW1: string;
  epoch: string;
  /** The caller's own current generation (agents resolve to their owner). */
  generation: () => Promise<string>;
}

interface ReadRoute {
  name: string;
  /** Minimum human role; "member" = any current member; "sync" = feed/bootstrap surfaces. */
  floor: "viewer" | "contributor" | "owner" | "member" | "sync";
  call: (bearer: string, ctx: RouteContext) => Promise<Response>;
}

function readRoutes(): ReadRoute[] {
  const paramsW = (w: string) => ({ params: Promise.resolve({ w }) });
  const paramsWP = (w: string, p: string) => ({ params: Promise.resolve({ w, p }) });
  const paramsWR = (w: string, r: string) => ({ params: Promise.resolve({ w, r }) });
  return [
    { name: "workspace detail", floor: "member", call: (b, c) => workspaceDetailRoute(request(`workspaces/${c.w1}`, { bearer: b }), paramsW(c.w1)) },
    { name: "prompts", floor: "viewer", call: (b, c) => promptsRoute(request(`workspaces/${c.w1}/prompts`, { bearer: b }), paramsW(c.w1)) },
    { name: "prompt detail", floor: "viewer", call: (b, c) => promptDetailRoute(request(`workspaces/${c.w1}/prompts/${c.promptW1}`, { bearer: b }), paramsWP(c.w1, c.promptW1)) },
    {
      name: "prompt revisions",
      floor: "viewer",
      call: (b, c) => revisionsRoute(request(`workspaces/${c.w1}/prompts/${c.promptW1}/revisions`, { bearer: b }), paramsWP(c.w1, c.promptW1)),
    },
    {
      name: "revision detail",
      floor: "viewer",
      call: (b, c) => revisionDetailRoute(request(`workspaces/${c.w1}/revisions/${c.revisionW1}`, { bearer: b }), paramsWR(c.w1, c.revisionW1)),
    },
    { name: "tags", floor: "viewer", call: (b, c) => tagsRoute(request(`workspaces/${c.w1}/tags`, { bearer: b }), paramsW(c.w1)) },
    { name: "collections", floor: "viewer", call: (b, c) => collectionsRoute(request(`workspaces/${c.w1}/collections`, { bearer: b }), paramsW(c.w1)) },
    { name: "proposals", floor: "contributor", call: (b, c) => proposalsRoute(request(`workspaces/${c.w1}/proposals`, { bearer: b }), paramsW(c.w1)) },
    {
      name: "activity items",
      floor: "contributor",
      call: (b, c) => activityRoute(request(`workspaces/${c.w1}/activity-items`, { bearer: b, query: { promptId: c.promptW1 } }), paramsW(c.w1)),
    },
    { name: "members", floor: "owner", call: (b, c) => membersRoute(request(`workspaces/${c.w1}/members`, { bearer: b }), paramsW(c.w1)) },
    { name: "invitations", floor: "owner", call: (b, c) => invitationsRoute(request(`workspaces/${c.w1}/invitations`, { bearer: b }), paramsW(c.w1)) },
    { name: "audit", floor: "owner", call: (b, c) => auditRoute(request(`workspaces/${c.w1}/audit`, { bearer: b }), paramsW(c.w1)) },
    {
      name: "changes feed",
      floor: "sync",
      call: async (b, c) =>
        changesRoute(
          request(`workspaces/${c.w1}/changes`, { bearer: b, query: { after: "0", serverEpoch: c.epoch, membershipGeneration: await c.generation() } }),
          paramsW(c.w1),
        ),
    },
    {
      name: "bootstrap start",
      floor: "sync",
      call: async (b, c) =>
        bootstrapRoute(
          request(`workspaces/${c.w1}/bootstrap`, { bearer: b, method: "POST", body: { membershipGeneration: await c.generation(), serverEpoch: c.epoch } }),
          paramsW(c.w1),
        ),
    },
  ];
}

interface Principal {
  role: Role;
  bearer: string;
  /** The user id the principal resolves to (agents: their owner). */
  userId: string;
  /** Human role rank inside W1 (0 for outsiders/foreign/agent-as-viewer). */
  rank: number;
}

function principals(): Principal[] {
  return [
    { role: "none", bearer: f.gavin.bearer, userId: f.gavin.id, rank: 0 },
    { role: "foreign", bearer: f.bob.bearer, userId: f.bob.id, rank: 0 },
    { role: "viewer", bearer: f.erin.bearer, userId: f.erin.id, rank: ROLE_RANK.viewer! },
    { role: "contributor", bearer: f.dana.bearer, userId: f.dana.id, rank: ROLE_RANK.contributor! },
    { role: "maintainer", bearer: f.carol.bearer, userId: f.carol.id, rank: ROLE_RANK.maintainer! },
    { role: "owner", bearer: f.alice.bearer, userId: f.alice.id, rank: ROLE_RANK.owner! },
    { role: "agent", bearer: f.agentBearer, userId: f.agentOwnerId, rank: ROLE_RANK.viewer! },
  ];
}

function allowed(principal: Principal, route: ReadRoute): boolean {
  switch (route.floor) {
    case "viewer":
    case "sync":
      // Every member passes viewer-level reads; agents count as viewer-level
      // and resolve to their owner's membership on the sync surfaces.
      return true;
    case "member":
      // Workspace detail is human-only (agents list their single workspace).
      return principal.role !== "agent";
    case "contributor":
    case "owner":
      return principal.role !== "agent" && principal.rank >= ROLE_RANK[route.floor]!;
  }
}

function ctxFor(principal: Principal): RouteContext {
  return {
    w1: f.w1.id,
    promptW1: f.promptW1,
    revisionW1: f.revisionW1,
    epoch: f.w1.serverEpoch,
    generation: async () => {
      const row = await setup.pool.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [f.w1.id, principal.userId],
      );
      // Non-members never reach generation checks; any syntactic value works.
      return row.rows[0]?.generation ?? randomUUID();
    },
  };
}

describe("authorization matrix", () => {
  for (const route of readRoutes()) {
    it(`${route.name}: exact role floor, no-store on every response, no content leak in any body`, async () => {
      for (const principal of principals()) {
        if (principal.role === "none" || principal.role === "foreign") continue; // covered below
        const response = await route.call(principal.bearer, ctxFor(principal));
        const expectAllowed = allowed(principal, route);
        const okStatus = response.status === 200 || response.status === 201;
        expect(okStatus, `${route.name} as ${principal.role} → ${response.status}`).toBe(expectAllowed);
        expect(response.headers.get("cache-control"), `${route.name} as ${principal.role}`).toBe("private, no-store");
        expectNoCrossLeak(await bodyText(response), `${route.name} as ${principal.role}`);
      }
    });
  }

  for (const route of readRoutes()) {
    it(`${route.name}: outsider and foreign-workspace member get 403 with no leak`, async () => {
      for (const who of principals().filter((p) => p.role === "none" || p.role === "foreign")) {
        const response = await route.call(who.bearer, ctxFor(who));
        expect(response.status, `${route.name} denied`).toBe(403);
        const text = await bodyText(response);
        expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("WORKSPACE_FORBIDDEN");
        expectNoLeak(text, `${route.name} denied`);
      }
    });
  }

  it("foreign nested IDs resolve to 404 inside the caller's workspace, never the other side's data", async () => {
    const nestedPrompt = await promptDetailRoute(request(`workspaces/${f.w1.id}/prompts/${f.promptW2}`, { bearer: f.alice.bearer }), {
      params: Promise.resolve({ w: f.w1.id, p: f.promptW2 }),
    });
    expect(nestedPrompt.status).toBe(404);
    expectNoLeak(await bodyText(nestedPrompt), "nested foreign prompt");

    const nestedRevision = await revisionDetailRoute(request(`workspaces/${f.w1.id}/revisions/${f.revisionW2}`, { bearer: f.carol.bearer }), {
      params: Promise.resolve({ w: f.w1.id, r: f.revisionW2 }),
    });
    expect(nestedRevision.status).toBe(404);
    expectNoLeak(await bodyText(nestedRevision), "nested foreign revision");

    const nestedProposal = await proposalDetailRoute(request(`workspaces/${f.w1.id}/proposals/${randomUUID()}`, { bearer: f.dana.bearer }), {
      params: Promise.resolve({ w: f.w1.id, p: randomUUID() }),
    });
    expect(nestedProposal.status).toBe(404);

    // W1 member asks on W2's path with W2's REAL prompt: forbidden before
    // any data access — the shared title must not confuse the boundary.
    const crossWorkspace = await promptDetailRoute(request(`workspaces/${f.w2.id}/prompts/${f.promptW2}`, { bearer: f.alice.bearer }), {
      params: Promise.resolve({ w: f.w2.id, p: f.promptW2 }),
    });
    expect(crossWorkspace.status).toBe(403);
    expectNoLeak(await bodyText(crossWorkspace), "cross-workspace access");
  });

  it("unknown workspaces 404 without revealing whether the id exists", async () => {
    const ghost = randomUUID();
    const response = await workspaceDetailRoute(request(`workspaces/${ghost}`, { bearer: f.alice.bearer }), {
      params: Promise.resolve({ w: ghost }),
    });
    expect(response.status).toBe(404);
    expectNoLeak(await bodyText(response), "unknown workspace");
  });
});

describe("command negatives", () => {
  it("ignores spoofed actor fields — authorization always comes from the authenticated principal", async () => {
    const before = await setup.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM team_invitations WHERE workspace_id = $1", [f.w1.id]);
    const spoofed = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.dana.bearer,
        method: "POST",
        epoch: f.w1.serverEpoch,
        body: {
          commandId: randomUUID(),
          membershipGeneration: await generationOf(f.w1.id, f.dana.id),
          actor: { userId: f.alice.id, role: "owner" },
          operation: { type: "invitation.create", email: "spoofed@example.test", role: "maintainer" },
        },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect([403, 422]).toContain(spoofed.status);
    const after = await setup.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM team_invitations WHERE workspace_id = $1", [f.w1.id]);
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    expectNoLeak(await bodyText(spoofed), "spoofed actor");
  });

  it("a foreign member cannot replay another principal's receipt id", async () => {
    const commandId = randomUUID();
    const original = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.alice.bearer,
        method: "POST",
        epoch: f.w1.serverEpoch,
        body: {
          commandId,
          membershipGeneration: await generationOf(f.w1.id, f.alice.id),
          operation: { type: "prompt.metadata", promptId: f.promptW1, title: "W1 prompt", expectedEntityVersion: await promptVersion(f.w1.id, f.promptW1), description: "negatives" },
        },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(original.status).toBe(200);

    const replay = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.bob.bearer,
        method: "POST",
        epoch: f.w1.serverEpoch,
        body: {
          commandId,
          membershipGeneration: await generationOf(f.w2.id, f.bob.id),
          operation: { type: "prompt.metadata", promptId: f.promptW1, title: "stolen", expectedEntityVersion: 1 },
        },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(replay.status).toBe(403);
    expectNoLeak(await bodyText(replay), "foreign receipt replay");
  });

  it("rejects a stale epoch header before touching state", async () => {
    const response = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.alice.bearer,
        method: "POST",
        epoch: randomUUID(),
        body: {
          commandId: randomUUID(),
          membershipGeneration: await generationOf(f.w1.id, f.alice.id),
          operation: { type: "prompt.metadata", promptId: f.promptW1, title: "epoch", expectedEntityVersion: 1 },
        },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SERVER_EPOCH_CHANGED");
  });

  it("rejects garbage and stale cursors on the feed and bootstrap pages", async () => {
    const garbageCursor = await changesRoute(
      request(`workspaces/${f.w1.id}/changes`, {
        bearer: f.erin.bearer,
        query: { after: "not-a-cursor", serverEpoch: f.w1.serverEpoch, membershipGeneration: await generationOf(f.w1.id, f.erin.id) },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect([404, 409, 422]).toContain(garbageCursor.status);
    expectNoLeak(await bodyText(garbageCursor), "garbage cursor");

    const garbageSnapshot = await bootstrapPageRoute(
      request(`workspaces/${f.w1.id}/bootstrap/${randomUUID()}`, {
        bearer: f.erin.bearer,
        query: { serverEpoch: f.w1.serverEpoch, membershipGeneration: await generationOf(f.w1.id, f.erin.id) },
      }),
      { params: Promise.resolve({ w: f.w1.id, s: randomUUID() }) },
    );
    expect([404, 410, 422]).toContain(garbageSnapshot.status);
    expectNoLeak(await bodyText(garbageSnapshot), "garbage snapshot");
  });
});

describe("shared write quota", () => {
  it("returns 429 once the per-principal 60/minute bucket is exhausted, without affecting other principals", async () => {
    // Heather starts with an untouched bucket, so exactly 60 slots remain.
    // Under parallel suite load the loop may straddle a window boundary, so
    // keep firing within a time budget instead of a fixed iteration count.
    let sawLimit = false;
    const deadline = Date.now() + 150_000;
    for (let i = 0; i < 400 && !sawLimit && Date.now() < deadline; i++) {
      const response = await commandsRoute(
        request(`workspaces/${f.w1.id}/commands`, { bearer: f.heather.bearer, method: "POST", epoch: f.w1.serverEpoch, body: null }),
        { params: Promise.resolve({ w: f.w1.id }) },
      );
      if (response.status === 429) {
        sawLimit = true;
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      } else {
        // Pre-limit calls fail envelope validation — they never succeed.
        expect([403, 409, 422]).toContain(response.status);
      }
    }
    expect(sawLimit).toBe(true);

    // A different principal is untouched by heather's exhausted bucket…
    const bobStill = await commandsRoute(
      request(`workspaces/${f.w2.id}/commands`, { bearer: f.bob.bearer, method: "POST", epoch: f.w2.serverEpoch, body: null }),
      { params: Promise.resolve({ w: f.w2.id }) },
    );
    expect(bobStill.status).toBe(422);

    // …and a VALID gavin command is genuinely blocked, not just garbage.
    const blocked = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.heather.bearer,
        method: "POST",
        epoch: f.w1.serverEpoch,
        body: { commandId: randomUUID(), membershipGeneration: randomUUID(), operation: { type: "workspace.rename", name: "blocked", expectedEntityVersion: 1 } },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(blocked.status).toBe(429);
  }, 180_000);
});

describe("request body cap", () => {
  it("rejects an oversized declared body without reading it", async () => {
    const response = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, {
        bearer: f.gavin.bearer,
        method: "POST",
        epoch: f.w1.serverEpoch,
        body: { padding: "x".repeat(300_000) },
      }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects an oversized chunked stream with no content-length", async () => {
    const chunk = "x".repeat(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const response = await commandsRoute(
      request(`workspaces/${f.w1.id}/commands`, { bearer: f.gavin.bearer, method: "POST", epoch: f.w1.serverEpoch, rawBody: stream }),
      { params: Promise.resolve({ w: f.w1.id }) },
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("private-surface crawl exclusion", () => {
  it("never lists team URLs in sitemap.xml or llms.txt", async () => {
    expect(JSON.stringify(await sitemapFn())).not.toContain("/team");
    expect(await (await llmsRoute()).text()).not.toContain("/team");
  });

  it("keeps robots.txt disallowing the API subtree (which covers /api/team)", async () => {
    const robots = await robotsFn();
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules.flatMap((rule) => rule.disallow ?? [])).toEqual(expect.arrayContaining(["/p/", "/api/"]));
  });

  it("marks team pages noindex via layout metadata", () => {
    expect(teamLayoutMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("ships no per-workspace OpenGraph image routes under /team", async () => {
    const entries = await readdir(join(process.cwd(), "src/app/team"), { recursive: true });
    expect(entries.filter((entry) => /opengraph-image|twitter-image/.test(entry))).toEqual([]);
  });
});
