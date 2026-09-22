import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapPageSchema,
  bootstrapStartSchema,
  changesPageSchema,
  errorBodySchema,
  teamInfoSchema,
} from "../src/index.js";
import { fixtures } from "../src/testing/fixtures.js";
import {
  createMockServer,
  MOCK_TOKENS,
  type MockServerHandle,
} from "../src/testing/mock-server.js";

const seed = fixtures.catalogSeed;
const lifecycle = fixtures.proposalLifecycle;
const revocation = fixtures.membershipRevocation;

const BASE = "/api/team/v1";
const W = `${BASE}/workspaces/${seed.workspace.id}`;

interface ApiOptions {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  protocol?: string | null;
  epoch?: string | null;
}

async function api(server: MockServerHandle, method: string, path: string, options: ApiOptions = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.protocol !== null) {
    headers["x-promptbranch-team-protocol"] = options.protocol ?? "1";
  }
  if (options.epoch !== null && (method === "POST" || method === "DELETE")) {
    headers["x-promptbranch-team-epoch"] = options.epoch ?? seed.server.serverEpoch;
  }
  const token = options.token === undefined ? MOCK_TOKENS.owner : options.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${server.origin}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // NDJSON export and fault paths are not JSON.
  }
  return { status: response.status, headers: response.headers, json, text };
}

function commandBody(envelope: typeof lifecycle.envelopes.submit) {
  return envelope;
}

async function submitProposal(server: MockServerHandle, token: string = MOCK_TOKENS.contributor) {
  return api(server, "POST", `${W}/commands`, {
    token,
    body: commandBody(lifecycle.envelopes.submit),
  });
}


let server: MockServerHandle;
beforeEach(async () => {
  server = await createMockServer();
});
afterEach(async () => {
  await server.close();
});

describe("mock server: discovery and protocol", () => {
  it("serves public /info matching teamInfoSchema without auth", async () => {
    const res = await api(server, "GET", `${BASE}/info`, { token: null, protocol: null });
    expect(res.status).toBe(200);
    expect(teamInfoSchema.safeParse(res.json).success).toBe(true);
    expect((res.json as { serverId: string }).serverId).toBe(seed.server.serverId);
  });

  it("requires the protocol header on protected routes and returns 426", async () => {
    const res = await api(server, "GET", `${BASE}/workspaces`, { protocol: null });
    expect(res.status).toBe(426);
    expect(errorBodySchema.safeParse(res.json).success).toBe(true);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "PROTOCOL_UNSUPPORTED",
    );
  });

  it("rejects missing auth with 401 UNAUTHENTICATED", async () => {
    const res = await api(server, "GET", `${BASE}/workspaces`, { token: null });
    expect(res.status).toBe(401);
    expect((res.json as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("answers /health/ready without auth or protocol headers", async () => {
    const res = await api(server, "GET", `${BASE}/health/ready`, {
      token: null,
      protocol: null,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ready: true });
  });
});

describe("mock server: membership and privacy", () => {
  it("gives a nonmember a generic 403 without the workspace name", async () => {
    const res = await api(server, "GET", W, { token: MOCK_TOKENS.outsider });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "WORKSPACE_FORBIDDEN",
    );
    expect(JSON.stringify(res.json)).not.toContain("Alpha");
  });

  it("never exposes the candidate marker to a viewer on catalogue surfaces", async () => {
    expect((await submitProposal(server)).status).toBe(200);

    const search = await api(
      server,
      "GET",
      `${W}/prompts?q=${lifecycle.privacyMarker}`,
      { token: MOCK_TOKENS.viewer },
    );
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.json)).not.toContain(lifecycle.privacyMarker);

    const revisions = await api(
      server,
      "GET",
      `${W}/prompts/${lifecycle.promptId}/revisions`,
      { token: MOCK_TOKENS.viewer },
    );
    expect(JSON.stringify(revisions.json)).not.toContain(lifecycle.privacyMarker);

    const boot = await api(server, "POST", `${W}/bootstrap`, {
      token: MOCK_TOKENS.viewer,
      body: {
        membershipGeneration: seed.workspace.membershipGeneration,
        serverEpoch: seed.server.serverEpoch,
      },
    });
    expect(boot.status).toBe(201);
    const page = await api(
      server,
      "GET",
      `${W}/bootstrap/${(boot.json as { snapshotId: string }).snapshotId}`,
      { token: MOCK_TOKENS.viewer },
    );
    expect(JSON.stringify(page.json)).not.toContain(lifecycle.privacyMarker);

    const proposals = await api(server, "GET", `${W}/proposals`, {
      token: MOCK_TOKENS.viewer,
    });
    expect(proposals.status).toBe(403);
  });

  it("shows the candidate only through proposal detail to contributor+", async () => {
    const submit = await submitProposal(server);
    const proposalId = (
      submit.json as { result: { id: string } }
    ).result.id;
    const detail = await api(server, "GET", `${W}/proposals/${proposalId}`, {
      token: MOCK_TOKENS.maintainer,
    });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.json)).toContain(lifecycle.privacyMarker);
    const viewerDetail = await api(server, "GET", `${W}/proposals/${proposalId}`, {
      token: MOCK_TOKENS.viewer,
    });
    expect(viewerDetail.status).toBe(403);
  });
});

describe("mock server: command flow", () => {
  it("submits and approves a proposal, moving the approved head into the feed", async () => {
    const submit = await submitProposal(server);
    expect(submit.status).toBe(200);
    const proposalId = (submit.json as { result: { id: string } }).result.id;

    const review = structuredClone(lifecycle.envelopes.reviewApprove);
    review.operation.proposalId = proposalId;
    const detail = await api(server, "GET", `${W}/proposals/${proposalId}`, {
      token: MOCK_TOKENS.maintainer,
    });
    review.operation.candidateRevisionId = (
      detail.json as { candidate: { id: string } }
    ).candidate.id;
    const approve = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: review,
    });
    expect(approve.status).toBe(200);

    const prompt = await api(server, "GET", `${W}/prompts/${lifecycle.promptId}`, {
      token: MOCK_TOKENS.viewer,
    });
    expect(JSON.stringify(prompt.json)).toContain(lifecycle.privacyMarker);
    const approvedId = (
      prompt.json as { revision: { id: string } }
    ).revision.id;
    expect(approvedId).not.toBe(lifecycle.baseRevisionId);

    const changes = await api(
      server,
      "GET",
      `${W}/changes?after=6&serverEpoch=${seed.server.serverEpoch}&membershipGeneration=${seed.workspace.membershipGeneration}`,
    );
    expect(changesPageSchema.safeParse(changes.json).success).toBe(true);
    expect(JSON.stringify(changes.json)).toContain(approvedId);
  });

  it("rejects self-review with SELF_REVIEW", async () => {
    const submit = await submitProposal(server, MOCK_TOKENS.maintainer);
    const proposalId = (submit.json as { result: { id: string } }).result.id;
    const review = structuredClone(lifecycle.envelopes.reviewApprove);
    review.operation.proposalId = proposalId;
    const res = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: review,
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("SELF_REVIEW");
  });

  it("enforces STALE_BASE on the second of two competing approvals", async () => {
    const submitB = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: structuredClone(lifecycle.envelopes.submit),
    });
    const proposalB = (submitB.json as { result: { id: string } }).result.id;
    const submitCEnvelope = structuredClone(lifecycle.envelopes.submit);
    submitCEnvelope.commandId = "ca000199-0000-4000-8000-000000000199";
    const submitC = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: submitCEnvelope,
    });
    const proposalC = (submitC.json as { result: { id: string } }).result.id;

    const approveB = structuredClone(lifecycle.concurrency.approveB);
    approveB.operation.proposalId = proposalB;
    const detailB = await api(server, "GET", `${W}/proposals/${proposalB}`, {
      token: MOCK_TOKENS.maintainer,
    });
    approveB.operation.candidateRevisionId = (
      detailB.json as { candidate: { id: string } }
    ).candidate.id;
    const resB = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: approveB,
    });
    expect(resB.status).toBe(200);

    const approveC = structuredClone(lifecycle.concurrency.approveC);
    approveC.operation.proposalId = proposalC;
    const detailC = await api(server, "GET", `${W}/proposals/${proposalC}`, {
      token: MOCK_TOKENS.maintainer,
    });
    approveC.operation.candidateRevisionId = (
      detailC.json as { candidate: { id: string } }
    ).candidate.id;
    const resC = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: approveC,
    });
    expect(resC.status).toBe(409);
    expect((resC.json as { error: { code: string } }).error.code).toBe("STALE_BASE");

    const proposalAfter = await api(server, "GET", `${W}/proposals/${proposalC}`, {
      token: MOCK_TOKENS.maintainer,
    });
    expect((proposalAfter.json as { proposal: { status: string } }).proposal.status).toBe(
      "open",
    );
  });

  it("replays a command id with identical bytes and rejects different bytes", async () => {
    const first = await submitProposal(server);
    const second = await submitProposal(server);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(server.state.proposalCount).toBe(1);

    const reused = structuredClone(lifecycle.envelopes.submit);
    reused.operation.rationale = "A different request under the same command id.";
    const conflict = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: reused,
    });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { error: { code: string } }).error.code).toBe(
      "COMMAND_ID_REUSED",
    );
    expect(server.state.proposalCount).toBe(1);
  });

  it("rejects an envelope with an extra field as VALIDATION_FAILED", async () => {
    const res = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: { ...commandBody(lifecycle.envelopes.submit), actorId: "spoofed" },
    });
    expect(res.status).toBe(422);
    expect((res.json as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a mismatched membership generation and server epoch", async () => {
    const wrongGeneration = structuredClone(lifecycle.envelopes.submit);
    wrongGeneration.membershipGeneration = revocation.generationAfter;
    const gen = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: wrongGeneration,
    });
    expect(gen.status).toBe(409);
    expect((gen.json as { error: { code: string } }).error.code).toBe(
      "MEMBERSHIP_CHANGED",
    );

    const epoch = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: commandBody(lifecycle.envelopes.submit),
      epoch: "ee000000-0000-4000-8000-000000000099",
    });
    expect(epoch.status).toBe(410);
    expect((epoch.json as { error: { code: string } }).error.code).toBe(
      "SERVER_EPOCH_CHANGED",
    );
  });
});

describe("mock server: bootstrap and feed", () => {
  it("bootstraps the full catalogue and reuses an active snapshot", async () => {
    const input = {
      membershipGeneration: seed.workspace.membershipGeneration,
      serverEpoch: seed.server.serverEpoch,
    };
    const first = await api(server, "POST", `${W}/bootstrap`, { body: input });
    expect(first.status).toBe(201);
    expect(bootstrapStartSchema.safeParse(first.json).success).toBe(true);
    const snapshotId = (first.json as { snapshotId: string }).snapshotId;

    const second = await api(server, "POST", `${W}/bootstrap`, { body: input });
    expect(second.status).toBe(200);
    expect((second.json as { snapshotId: string }).snapshotId).toBe(snapshotId);

    const page = await api(server, "GET", `${W}/bootstrap/${snapshotId}`);
    expect(bootstrapPageSchema.safeParse(page.json).success).toBe(true);
    const records = (page.json as { records: unknown[]; nextPageToken: string | null })
      .records;
    // 2 prompts + 3 published revisions + 2 tags + 1 collection.
    expect(records.length).toBe(8);
  });

  it("returns an empty page at the current cursor and committed changes after it", async () => {
    const query = `serverEpoch=${seed.server.serverEpoch}&membershipGeneration=${seed.workspace.membershipGeneration}`;
    const before = await api(server, "GET", `${W}/changes?after=6&${query}`);
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ changes: [], nextCursor: "6", hasMore: false });

    const create = structuredClone(seed.seedCommands[0]!);
    create.operation.name = "operations";
    await api(server, "POST", `${W}/commands`, { body: create });
    const after = await api(server, "GET", `${W}/changes?after=6&${query}`);
    expect((after.json as { changes: unknown[] }).changes.length).toBe(1);
    expect(after.json).toMatchObject({ nextCursor: "7", hasMore: false });
  });
});

describe("mock server: injectable faults", () => {
  it("drop-response-after-commit commits once and replays the same receipt", async () => {
    const dropped = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.contributor,
      body: commandBody(lifecycle.envelopes.submit),
      headers: { "x-promptbranch-team-mock-fault": "drop-response-after-commit" },
    }).catch((error: unknown) => error);
    expect(dropped).toBeInstanceOf(Error);
    expect(server.state.proposalCount).toBe(1);

    const replay = await submitProposal(server);
    expect(replay.status).toBe(200);
    expect(server.state.proposalCount).toBe(1);
    expect(typeof (replay.json as { result: { id: string } }).result.id).toBe("string");
  });

  it("stale-base fault forces a 409 STALE_BASE on the next review", async () => {
    const submit = await submitProposal(server);
    const proposalId = (submit.json as { result: { id: string } }).result.id;
    const review = structuredClone(lifecycle.envelopes.reviewApprove);
    review.operation.proposalId = proposalId;
    const res = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: review,
      headers: { "x-promptbranch-team-mock-fault": "stale-base" },
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("STALE_BASE");
  });

  it("revoked-member fault answers workspace routes with 403", async () => {
    const res = await api(server, "GET", `${W}/prompts`, {
      headers: { "x-promptbranch-team-mock-fault": "revoked-member" },
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "WORKSPACE_FORBIDDEN",
    );
  });

  it("expired-bootstrap fault answers snapshot pages with 410", async () => {
    const boot = await api(server, "POST", `${W}/bootstrap`, {
      body: {
        membershipGeneration: seed.workspace.membershipGeneration,
        serverEpoch: seed.server.serverEpoch,
      },
    });
    const snapshotId = (boot.json as { snapshotId: string }).snapshotId;
    const res = await api(server, "GET", `${W}/bootstrap/${snapshotId}`, {
      headers: { "x-promptbranch-team-mock-fault": "expired-bootstrap" },
    });
    expect(res.status).toBe(410);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "SNAPSHOT_EXPIRED",
    );
  });

  it("unknown-feed-event fault emits a page clients must refuse", async () => {
    const res = await api(
      server,
      "GET",
      `${W}/changes?after=6&serverEpoch=${seed.server.serverEpoch}&membershipGeneration=${seed.workspace.membershipGeneration}`,
      { headers: { "x-promptbranch-team-mock-fault": "unknown-feed-event" } },
    );
    expect(res.status).toBe(200);
    expect(changesPageSchema.safeParse(res.json).success).toBe(false);
  });
});

describe("mock server: roles, agents and membership lifecycle", () => {
  it("scopes the agent token to read + own proposals and forbids review", async () => {
    const prompts = await api(server, "GET", `${W}/prompts`, {
      token: MOCK_TOKENS.agent,
    });
    expect(prompts.status).toBe(200);

    await submitProposal(server);
    const own = await api(server, "GET", `${W}/proposals`, { token: MOCK_TOKENS.agent });
    expect((own.json as { items: unknown[] }).items.length).toBe(0);

    const proposals = await api(server, "GET", `${W}/proposals`, {
      token: MOCK_TOKENS.maintainer,
    });
    const proposalId = (proposals.json as { items: { id: string }[] }).items[0]!.id;
    const review = structuredClone(lifecycle.envelopes.reviewApprove);
    review.operation.proposalId = proposalId;
    const reviewAsAgent = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.agent,
      body: review,
    });
    expect(reviewAsAgent.status).toBe(403);
    expect((reviewAsAgent.json as { error: { code: string } }).error.code).toBe(
      "SCOPE_FORBIDDEN",
    );

    const members = await api(server, "GET", `${W}/members`, {
      token: MOCK_TOKENS.agent,
    });
    expect(members.status).toBe(403);
  });

  it("protects the last owner and locks out a removed member immediately", async () => {
    const lastOwner = await api(server, "POST", `${W}/commands`, {
      body: structuredClone(revocation.envelopes.memberRemoveLastOwner),
    });
    expect(lastOwner.status).toBe(409);
    expect((lastOwner.json as { error: { code: string } }).error.code).toBe("LAST_OWNER");

    const remove = await api(server, "POST", `${W}/commands`, {
      body: structuredClone(revocation.envelopes.memberRemove),
    });
    expect(remove.status).toBe(200);

    const after = await api(server, "GET", `${W}/prompts`, {
      token: MOCK_TOKENS.contributor,
    });
    expect(after.status).toBe(403);
    expect((after.json as { error: { code: string } }).error.code).toBe(
      "WORKSPACE_FORBIDDEN",
    );

    const agentAfter = await api(server, "GET", `${W}/prompts`, {
      token: MOCK_TOKENS.agent,
    });
    // Removal revokes the member's agent tokens (C5): auth itself now fails.
    expect(agentAfter.status).toBe(401);

    const stale = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.owner,
      body: structuredClone(revocation.envelopes.workspaceRename),
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: { code: string } }).error.code).toBe(
      "MEMBERSHIP_CHANGED",
    );
  });
});

describe("mock server: review fix regressions", () => {
  it("approving a proposal on an archived prompt returns STALE_ENTITY", async () => {
    const submit = await submitProposal(server);
    expect(submit.status).toBe(200);
    const proposalId = (submit.json as { result: { id: string } }).result.id;

    const archive = {
      commandId: "ca000301-0000-4000-8000-000000000301",
      membershipGeneration: seed.workspace.membershipGeneration,
      operation: {
        type: "prompt.archive",
        promptId: lifecycle.promptId,
        expectedEntityVersion: 2,
      },
    };
    const archived = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: archive,
    });
    expect(archived.status).toBe(200);

    const review = structuredClone(lifecycle.envelopes.reviewApprove);
    review.operation.proposalId = proposalId;
    const detail = await api(server, "GET", `${W}/proposals/${proposalId}`, {
      token: MOCK_TOKENS.maintainer,
    });
    review.operation.candidateRevisionId = (
      detail.json as { candidate: { id: string } }
    ).candidate.id;
    const approve = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.maintainer,
      body: review,
    });
    expect(approve.status).toBe(409);
    expect((approve.json as { error: { code: string } }).error.code).toBe("STALE_ENTITY");
  });

  it("an agent token can comment only on its own proposals", async () => {
    // Proposal authored by the human contributor: the agent must not comment.
    const humanSubmit = await submitProposal(server);
    const humanProposalId = (humanSubmit.json as { result: { id: string } }).result.id;
    const foreignComment = structuredClone(lifecycle.envelopes.commentAdd);
    foreignComment.operation.proposalId = humanProposalId;
    const foreign = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.agent,
      body: foreignComment,
    });
    expect(foreign.status).toBe(403);
    expect((foreign.json as { error: { code: string } }).error.code).toBe(
      "SCOPE_FORBIDDEN",
    );

    // Proposal authored by the agent itself: commenting works.
    const agentSubmitEnvelope = structuredClone(lifecycle.envelopes.submit);
    agentSubmitEnvelope.commandId = "ca000302-0000-4000-8000-000000000302";
    const agentSubmit = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.agent,
      body: agentSubmitEnvelope,
    });
    expect(agentSubmit.status).toBe(200);
    const ownProposalId = (agentSubmit.json as { result: { id: string } }).result.id;
    const ownComment = structuredClone(lifecycle.envelopes.commentAdd);
    ownComment.commandId = "ca000303-0000-4000-8000-000000000303";
    ownComment.operation.proposalId = ownProposalId;
    const own = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.agent,
      body: ownComment,
    });
    expect(own.status).toBe(200);
  });

  it("an agent without proposal:write cannot withdraw, even as the owning user", async () => {
    // The full-scope agent authors a proposal.
    const agentSubmitEnvelope = structuredClone(lifecycle.envelopes.submit);
    agentSubmitEnvelope.commandId = "ca000304-0000-4000-8000-000000000304";
    const agentSubmit = await api(server, "POST", `${W}/commands`, {
      token: MOCK_TOKENS.agent,
      body: agentSubmitEnvelope,
    });
    const proposalId = (agentSubmit.json as { result: { id: string } }).result.id;

    // Mint a note:write-only token for the same user (Casey).
    const mint = await api(server, "POST", `${W}/agent-tokens`, {
      token: MOCK_TOKENS.contributor,
      body: {
        commandId: "ca000305-0000-4000-8000-000000000305",
        name: "notes-only",
        scopes: ["catalog:read", "note:write"],
        expiresInDays: 30,
      },
    });
    expect(mint.status).toBe(201);
    const notesOnly = (mint.json as { token: string }).token;

    const withdraw = structuredClone(lifecycle.envelopes.withdraw);
    withdraw.operation.proposalId = proposalId;
    const res = await api(server, "POST", `${W}/commands`, {
      token: notesOnly,
      body: withdraw,
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("SCOPE_FORBIDDEN");
  });

  it("expiresInDays defaults to 30 when omitted", async () => {
    const mint = await api(server, "POST", `${W}/agent-tokens`, {
      token: MOCK_TOKENS.contributor,
      body: {
        commandId: "ca000306-0000-4000-8000-000000000306",
        name: "default-expiry",
        scopes: ["catalog:read"],
      },
    });
    expect(mint.status).toBe(201);
    const expiresAt = Date.parse((mint.json as { expiresAt: string }).expiresAt);
    const days = (expiresAt - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });
});
