import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandEnvelope, TeamOperation } from "@promptbranch/team-contract";
import { TEAM_ROUTES } from "@promptbranch/team-contract";
import {
  createMockServer,
  fixtures,
  MOCK_TOKENS,
  type MockServerHandle,
  type MockServerOptions,
} from "@promptbranch/team-contract/testing";
import {
  createTeamClient,
  TeamApiError,
  TeamOriginError,
  type TeamClient,
} from "../src/index.js";
import type { TeamClock } from "../src/transport.js";

const seed = fixtures.catalogSeed;
const WORKSPACE_ID = seed.workspace.id;
const GENERATION = seed.workspace.membershipGeneration;
const EPOCH = seed.server.serverEpoch;
const PROMPT_ID = seed.prompts[0]!.prompt.id;
const HEAD_REVISION_ID = seed.prompts[0]!.prompt.approvedRevisionId;

/** Instant, deterministic clock so retries cost no wall time in tests. */
const instantClock: TeamClock = {
  sleep: () => Promise.resolve(),
  random: () => 0.5,
};

function clientFor(server: MockServerHandle, token: string | null): TeamClient {
  return createTeamClient({
    origin: server.origin,
    tokenSource: () => token,
    clock: instantClock,
  });
}

function envelope(operation: TeamOperation, commandId = randomUUID()): CommandEnvelope {
  return { commandId, membershipGeneration: GENERATION, operation };
}

/** Every C4 operationId maps to exactly one client method (route parity). */
const ROUTE_METHODS: Record<string, keyof TeamClient> = {
  getInfo: "info",
  getMe: "getMe",
  deleteMe: "deleteMe",
  getPrincipal: "getPrincipal",
  listWorkspaces: "listWorkspaces",
  createWorkspace: "createWorkspace",
  getWorkspace: "getWorkspace",
  listPrompts: "listPrompts",
  getPrompt: "getPrompt",
  listRevisions: "listRevisions",
  getRevision: "getRevision",
  listTags: "listTags",
  listCollections: "listCollections",
  listProposals: "listProposals",
  getProposal: "getProposal",
  listProposalComments: "listProposalComments",
  listActivityItems: "listActivityItems",
  listMembers: "listMembers",
  listInvitations: "listInvitations",
  acceptInvitation: "acceptInvitation",
  listAudit: "listAudit",
  exportWorkspace: "exportWorkspace",
  listSessions: "listSessions",
  revokeSession: "revokeSession",
  revokeAllSessions: "revokeAllSessions",
  listAgentTokens: "listAgentTokens",
  createAgentToken: "createAgentToken",
  revokeAgentToken: "revokeAgentToken",
  submitCommand: "command",
  startBootstrap: "bootstrap",
  getBootstrapPage: "bootstrapPage",
  getChanges: "changes",
  healthReady: "healthReady",
};

describe("route parity with the C4 surface", () => {
  it("implements a method for every TEAM_ROUTES operation", () => {
    const client = createTeamClient({ origin: "http://127.0.0.1:4318", tokenSource: () => null });
    for (const route of TEAM_ROUTES) {
      const method = ROUTE_METHODS[route.operationId];
      expect(method, route.operationId).toBeDefined();
      expect(typeof client[method!], route.operationId).toBe("function");
    }
    expect(Object.keys(ROUTE_METHODS)).toHaveLength(TEAM_ROUTES.length);
  });

  it("requires an explicit origin at construction", () => {
    expect(() => createTeamClient({ origin: "" })).toThrowError(TeamOriginError);
    expect(() => createTeamClient({ origin: "http://team.example.com" })).toThrowError(
      TeamOriginError,
    );
  });
});

describe("team client against the contract mock server", () => {
  let servers: MockServerHandle[];
  let server: MockServerHandle;
  let owner: TeamClient;

  async function spawn(options?: MockServerOptions): Promise<MockServerHandle> {
    const handle = await createMockServer(options);
    servers.push(handle);
    return handle;
  }

  beforeEach(async () => {
    servers = [];
    server = await spawn();
    owner = clientFor(server, MOCK_TOKENS.owner);
  });

  afterEach(async () => {
    for (const handle of servers) await handle.close();
  });

  describe("discovery and identity", () => {
    it("reads server info with limits and required features", async () => {
      const info = await owner.info();
      expect(info.serverId).toBe(seed.server.serverId);
      expect(info.serverEpoch).toBe(EPOCH);
      expect(info.features).toEqual(
        expect.arrayContaining(["catalog-v1", "review-v1", "changes-v1", "agent-token-v1"]),
      );
      expect(info.limits.maxRequestBytes).toBe(262144);
    });

    it("refuses activation when a required feature is missing (C2)", async () => {
      const broken = await spawn({
        seed: {
          ...seed,
          server: { ...seed.server, features: ["catalog-v1", "review-v1", "changes-v1"] },
        },
      });
      const client = clientFor(broken, MOCK_TOKENS.owner);
      await expect(client.info()).rejects.toMatchObject({ reason: "unsupported-server" });
    });

    it("reads /me for a human and /principal for human and agent", async () => {
      const me = await owner.getMe();
      expect(me.user.email).toBe("alice@example.test");
      expect(me.workspaces.map((w) => w.id)).toContain(WORKSPACE_ID);

      const humanPrincipal = await owner.getPrincipal();
      expect(humanPrincipal).toMatchObject({ kind: "human", agentTokenId: null });

      const agent = clientFor(server, MOCK_TOKENS.agent);
      const agentPrincipal = await agent.getPrincipal();
      expect(agentPrincipal.kind).toBe("agent");
      expect(agentPrincipal.scopes).toContain("proposal:write");
    });

    it("reports readiness without auth", async () => {
      const anonymous = clientFor(server, null);
      await expect(anonymous.healthReady()).resolves.toEqual({ ready: true });
    });
  });

  describe("workspaces", () => {
    it("lists and gets workspaces with freshly resolved roles", async () => {
      const page = await owner.listWorkspaces();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: WORKSPACE_ID, role: "owner" });

      const workspace = await owner.getWorkspace(WORKSPACE_ID);
      expect(workspace.membershipGeneration).toBe(GENERATION);
    });

    it("creates a workspace idempotently per command id", async () => {
      const commandId = randomUUID();
      const first = await owner.createWorkspace({ commandId, name: "Beta" });
      expect(first.workspace.role).toBe("owner");
      const replay = await owner.createWorkspace({ commandId, name: "Beta" });
      expect(replay.workspace.id).toBe(first.workspace.id);
    });

    it("rejects invalid input locally before any request", async () => {
      await expect(
        owner.createWorkspace({ commandId: "not-a-uuid", name: "Beta" }),
      ).rejects.toMatchObject({ reason: "invalid-request" });
    });
  });

  describe("catalogue reads", () => {
    it("browses prompts with search, filters and pagination", async () => {
      const all = await owner.listPrompts(WORKSPACE_ID);
      expect(all.items.length).toBe(2);

      const found = await owner.listPrompts(WORKSPACE_ID, { q: "PR review" });
      expect(found.items.map((p) => p.title)).toEqual(["PR review checklist"]);

      const paged = await owner.listPrompts(WORKSPACE_ID, { limit: 1 });
      expect(paged.items).toHaveLength(1);
      expect(paged.nextPageToken).not.toBeNull();
      const rest = await owner.listPrompts(WORKSPACE_ID, {
        limit: 1,
        pageToken: paged.nextPageToken!,
      });
      expect(rest.items).toHaveLength(1);
      expect(rest.items[0]!.id).not.toBe(paged.items[0]!.id);
    });

    it("reads a prompt with its approved head revision", async () => {
      const detail = await owner.getPrompt(WORKSPACE_ID, PROMPT_ID);
      expect(detail.prompt.approvedRevisionId).toBe(HEAD_REVISION_ID);
      expect(detail.revision.id).toBe(HEAD_REVISION_ID);
      expect(detail.revision.content).toContain("Summarize the issue");
    });

    it("lists published revisions newest first and reads one revision", async () => {
      const page = await owner.listRevisions(WORKSPACE_ID, PROMPT_ID);
      expect(page.items).toHaveLength(2);
      expect(page.items[0]!.id).toBe(HEAD_REVISION_ID);

      const revision = await owner.getRevision(WORKSPACE_ID, HEAD_REVISION_ID);
      expect(revision.contentFormat).toBe("markdown");

      await expect(
        owner.getRevision(WORKSPACE_ID, randomUUID()),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    });

    it("lists tags and collections", async () => {
      const tags = await owner.listTags(WORKSPACE_ID);
      expect(tags.items.map((t) => t.name).sort()).toEqual(["release", "triage"]);
      const collections = await owner.listCollections(WORKSPACE_ID);
      expect(collections.items.map((c) => c.name)).toEqual(["Support macros"]);
    });
  });

  describe("commands and the proposal workflow", () => {
    const contributor = () => clientFor(server, MOCK_TOKENS.contributor);
    const maintainer = () => clientFor(server, MOCK_TOKENS.maintainer);

    async function submitProposal(
      content: string,
      commandId = randomUUID(),
    ): Promise<{ proposalId: string }> {
      const receipt = await contributor().command(
        WORKSPACE_ID,
        EPOCH,
        envelope(
          {
            type: "proposal.submit",
            promptId: PROMPT_ID,
            baseRevisionId: HEAD_REVISION_ID,
            content,
            rationale: "Improve the structure.",
            supersedesProposalId: null,
          },
          commandId,
        ),
      );
      expect(receipt.result.kind).toBe("proposal");
      return { proposalId: receipt.result.id };
    }

    it("submits a proposal and reads it back with base and candidate", async () => {
      const { proposalId } = await submitProposal("Summarize, cite evidence, act.\n");
      const detail = await owner.getProposal(WORKSPACE_ID, proposalId);
      expect(detail.proposal.status).toBe("open");
      expect(detail.base.id).toBe(HEAD_REVISION_ID);
      expect(detail.candidate.content).toBe("Summarize, cite evidence, act.\n");
      expect(detail.reviews).toEqual([]);

      const list = await owner.listProposals(WORKSPACE_ID, { status: "open" });
      expect(list.items.map((p) => p.id)).toContain(proposalId);
    });

    it("replays a dropped command response through the receipt (C6)", async () => {
      const dropping = await spawn({ faults: ["drop-response-after-commit"] });
      const commandId = randomUUID();
      const receipt = await clientFor(dropping, MOCK_TOKENS.contributor).command(
        WORKSPACE_ID,
        EPOCH,
        envelope(
          {
            type: "proposal.submit",
            promptId: PROMPT_ID,
            baseRevisionId: HEAD_REVISION_ID,
            content: "Retried after a lost response.\n",
            rationale: "Confirm idempotent retry.",
            supersedesProposalId: null,
          },
          commandId,
        ),
      );
      expect(receipt.commandId).toBe(commandId);
      expect(dropping.state.receiptCount).toBe(1);
      expect(dropping.state.proposalCount).toBe(1);
    });

    it("surfaces STALE_BASE on a losing concurrent approval and never retries it", async () => {
      const first = await submitProposal("Candidate B content.\n");
      const second = await submitProposal("Candidate C content.\n");

      const approve = async (proposalId: string) => {
        const detail = await owner.getProposal(WORKSPACE_ID, proposalId);
        return maintainer().command(
          WORKSPACE_ID,
          EPOCH,
          envelope({
            type: "proposal.review",
            proposalId,
            expectedEntityVersion: detail.proposal.entityVersion,
            candidateRevisionId: detail.candidate.id,
            candidateContentHash: detail.candidate.contentHash,
            expectedApprovedRevisionId: HEAD_REVISION_ID,
            decision: "approve",
            comment: "Looks good.",
          }),
        );
      };

      const approved = await approve(first.proposalId);
      expect(approved.result.kind).toBe("review");

      await expect(approve(second.proposalId)).rejects.toMatchObject({
        code: "STALE_BASE",
        status: 409,
      });

      const head = await owner.getPrompt(WORKSPACE_ID, PROMPT_ID);
      expect(head.revision.content).toBe("Candidate B content.\n");
    });

    it("rejects commands with a stale membership generation or epoch", async () => {
      await expect(
        owner.command(WORKSPACE_ID, EPOCH, {
          commandId: randomUUID(),
          membershipGeneration: randomUUID(),
          operation: { type: "tag.create", name: "new-tag" },
        }),
      ).rejects.toMatchObject({ code: "MEMBERSHIP_CHANGED" });

      await expect(
        owner.command(
          WORKSPACE_ID,
          randomUUID(),
          envelope({ type: "tag.create", name: "new-tag" }),
        ),
      ).rejects.toMatchObject({ code: "SERVER_EPOCH_CHANGED", status: 410 });
    });

    it("runs maintainer commands end to end", async () => {
      const tagReceipt = await maintainer().command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "tag.create", name: "from-client" }),
      );
      expect(tagReceipt.result).toMatchObject({ kind: "tag", entityVersion: 1 });

      const metadata = await maintainer().command(
        WORKSPACE_ID,
        EPOCH,
        envelope({
          type: "prompt.metadata",
          promptId: PROMPT_ID,
          title: "Support reply: summary first",
          description: "Updated description.",
          tagIds: [seed.tags[0]!.id, tagReceipt.result.id],
          collectionIds: [seed.collections[0]!.id],
          expectedEntityVersion: 2,
        }),
      );
      expect(metadata.result.kind).toBe("prompt");

      const detail = await owner.getPrompt(WORKSPACE_ID, PROMPT_ID);
      expect(detail.prompt.description).toBe("Updated description.");
      expect(detail.prompt.tagIds).toContain(tagReceipt.result.id);
    });

    it("adds comments, notes and run summaries", async () => {
      const { proposalId } = await submitProposal("Content for commenting.\n");
      const commentReceipt = await contributor().command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "comment.add", proposalId, body: "First pass looks fine." }),
      );
      expect(commentReceipt.result.kind).toBe("comment");

      const comments = await owner.listProposalComments(WORKSPACE_ID, proposalId);
      expect(comments.items.map((c) => c.body)).toEqual(["First pass looks fine."]);

      await contributor().command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "note.add", promptId: PROMPT_ID, revisionId: HEAD_REVISION_ID, body: "Used in incident 42." }),
      );
      await contributor().command(
        WORKSPACE_ID,
        EPOCH,
        envelope({
          type: "run.report",
          promptId: PROMPT_ID,
          revisionId: HEAD_REVISION_ID,
          body: "Smoke run.",
          model: "gpt-test",
          status: "completed",
          latencyMs: 812,
          inputTokens: 120,
          outputTokens: 44,
          estimatedCostUsd: 0.0021,
        }),
      );

      const activity = await owner.listActivityItems(WORKSPACE_ID, { promptId: PROMPT_ID });
      expect(activity.items.map((item) => item.kind).sort()).toEqual(["note", "run"]);
      const run = activity.items.find((item) => item.kind === "run");
      expect(run?.run).toMatchObject({ model: "gpt-test", status: "completed", latencyMs: 812 });
    });
  });

  describe("authorization mapping", () => {
    it("rejects unknown bearer tokens as UNAUTHENTICATED", async () => {
      const stranger = clientFor(server, "pbtest_forged");
      await expect(stranger.getWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401,
      });
    });

    it("returns WORKSPACE_FORBIDDEN for a nonmember without workspace metadata", async () => {
      const outsider = clientFor(server, MOCK_TOKENS.outsider);
      const error = await outsider.getWorkspace(WORKSPACE_ID).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TeamApiError);
      expect(error).toMatchObject({ code: "WORKSPACE_FORBIDDEN", status: 403 });
      expect(JSON.stringify(error)).not.toContain("Alpha");
    });

    it("keeps owner routes away from viewers", async () => {
      const viewer = clientFor(server, MOCK_TOKENS.viewer);
      await expect(viewer.listMembers(WORKSPACE_ID)).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
        status: 403,
      });
      await expect(viewer.listAudit(WORKSPACE_ID)).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
      });
    });
  });

  describe("owner administration routes", () => {
    it("lists members and audit entries as owner", async () => {
      const members = await owner.listMembers(WORKSPACE_ID);
      expect(members.items.map((m) => m.role).sort()).toEqual([
        "contributor",
        "maintainer",
        "owner",
        "viewer",
      ]);

      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "audited" }));
      const audit = await owner.listAudit(WORKSPACE_ID);
      expect(audit.items.some((entry) => entry.action === "tag.create")).toBe(true);
    });

    it("creates, lists and revokes invitations without exposing raw tokens", async () => {
      const created = await owner.command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "invitation.create", email: "new@example.test", role: "viewer" }),
      );
      expect(created.result.kind).toBe("invitation");

      const invitations = await owner.listInvitations(WORKSPACE_ID);
      expect(invitations.items).toHaveLength(1);
      expect(invitations.items[0]).toMatchObject({ email: "new@example.test", status: "pending" });
      expect(JSON.stringify(invitations)).not.toContain("token");

      const revoked = await owner.command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "invitation.revoke", invitationId: created.result.id }),
      );
      expect(revoked.result.kind).toBe("invitation");
    });

    it("reports NOT_FOUND when accepting an unknown invitation token", async () => {
      await expect(
        owner.acceptInvitation({ commandId: randomUUID(), token: "no-such-token" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("streams the owner NDJSON export", async () => {
      const exported = await owner.exportWorkspace(WORKSPACE_ID);
      const lines: string[] = [];
      for await (const line of exported.lines) lines.push(line);
      expect(lines.length).toBeGreaterThan(1);
      const manifest = JSON.parse(lines[0]!) as { schemaVersion: number; workspaceId: string };
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.workspaceId).toBe(WORKSPACE_ID);
      // Manifest, then domain entities (2 tags + 1 collection + 2 prompts + 3 revisions).
      expect(lines).toHaveLength(1 + 2 + 1 + 2 + 3);

      const viewer = clientFor(server, MOCK_TOKENS.viewer);
      await expect(viewer.exportWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
      });
    });
  });

  describe("sessions and account routes", () => {
    it("lists, revokes one and revokes all sessions", async () => {
      const sessions = await owner.listSessions();
      expect(sessions.items.length).toBeGreaterThanOrEqual(1);

      await expect(owner.revokeSession(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(owner.revokeAllSessions()).resolves.toEqual({ ok: true });
      await expect(owner.getMe()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it("deletes the account only with the confirmed email", async () => {
      await expect(owner.deleteMe({ confirmEmail: "wrong@example.test" })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(owner.deleteMe({ confirmEmail: "alice@example.test" })).resolves.toEqual({
        ok: true,
      });
      await expect(owner.getMe()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  describe("agent tokens", () => {
    it("mints a token once; replay hides the secret", async () => {
      const commandId = randomUUID();
      const created = await owner.createAgentToken(WORKSPACE_ID, {
        commandId,
        name: "ci-bot",
        scopes: ["catalog:read"],
      });
      expect(created.secretAvailable).toBe(true);
      expect(created.token).toMatch(/^pbt_/);

      const replay = await owner.createAgentToken(WORKSPACE_ID, {
        commandId,
        name: "ci-bot",
        scopes: ["catalog:read"],
      });
      expect(replay.secretAvailable).toBe(false);
      expect(replay.token).toBeUndefined();
      expect(replay.id).toBe(created.id);

      const listed = await owner.listAgentTokens(WORKSPACE_ID);
      expect(listed.items.map((t) => t.id)).toContain(created.id);
      expect(JSON.stringify(listed)).not.toContain(created.token!);
    });

    it("revokes a token, which immediately disables it", async () => {
      const created = await owner.createAgentToken(WORKSPACE_ID, {
        commandId: randomUUID(),
        name: "short-lived",
        scopes: ["catalog:read"],
      });
      const agentClient = clientFor(server, created.token!);
      await expect(agentClient.listPrompts(WORKSPACE_ID)).resolves.toBeDefined();

      await owner.revokeAgentToken(WORKSPACE_ID, created.id);
      await expect(agentClient.listPrompts(WORKSPACE_ID)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    });
  });

  describe("bootstrap and change feed (C7)", () => {
    it("bootstraps a snapshot and pages through the whole catalogue", async () => {
      const start = await owner.bootstrap(WORKSPACE_ID, {
        membershipGeneration: GENERATION,
        serverEpoch: EPOCH,
      });
      expect(start.highWater).toBe(fixtures.catalogChanges.baseSeq);

      const records: unknown[] = [];
      let pageToken: string | undefined;
      for (;;) {
        const page = await owner.bootstrapPage(WORKSPACE_ID, start.snapshotId, {
          pageToken,
          limit: 2,
        });
        records.push(...page.records);
        if (page.nextPageToken === null) break;
        pageToken = page.nextPageToken;
      }
      // 2 tags + 1 collection + 2 prompts + 3 published revisions.
      expect(records).toHaveLength(8);

      const reuse = await owner.bootstrap(WORKSPACE_ID, {
        membershipGeneration: GENERATION,
        serverEpoch: EPOCH,
      });
      expect(reuse.snapshotId).toBe(start.snapshotId);
    });

    it("returns committed changes after a cursor in commit order", async () => {
      const before = await owner.changes(WORKSPACE_ID, {
        after: fixtures.catalogChanges.baseSeq,
        serverEpoch: EPOCH,
        membershipGeneration: GENERATION,
      });
      expect(before.changes).toEqual([]);
      expect(before.hasMore).toBe(false);

      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "feed-marker" }));
      const after = await owner.changes(WORKSPACE_ID, {
        after: before.nextCursor,
        serverEpoch: EPOCH,
        membershipGeneration: GENERATION,
      });
      expect(after.changes).toHaveLength(1);
      expect(after.changes[0]!.records[0]).toMatchObject({
        entity: "tag",
        value: { name: "feed-marker" },
      });
      expect(after.nextCursor).toBe(after.changes[0]!.seq);
    });

    it("pauses on a non-conforming feed event instead of advancing", async () => {
      const poisoned = await spawn({ faults: ["unknown-feed-event"] });
      const client = clientFor(poisoned, MOCK_TOKENS.owner);
      await expect(
        client.changes(WORKSPACE_ID, {
          after: fixtures.catalogChanges.baseSeq,
          serverEpoch: EPOCH,
          membershipGeneration: GENERATION,
        }),
      ).rejects.toMatchObject({ reason: "invalid-response" });
    });

    it("surfaces snapshot expiry as a typed 410", async () => {
      const expiring = await spawn({ faults: ["expired-bootstrap"] });
      const client = clientFor(expiring, MOCK_TOKENS.owner);
      const start = await client.bootstrap(WORKSPACE_ID, {
        membershipGeneration: GENERATION,
        serverEpoch: EPOCH,
      });
      await expect(
        client.bootstrapPage(WORKSPACE_ID, start.snapshotId, {}),
      ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", status: 410 });
    });
  });
});
