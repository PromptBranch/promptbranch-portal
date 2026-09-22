import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelope, CommandReceipt, TeamOperation } from "@promptbranch/team-contract";
import {
  createMockServer,
  fixtures,
  MOCK_FAULT_HEADER,
  MOCK_TOKENS,
  type MockFault,
  type MockServerHandle,
  type MockServerOptions,
} from "@promptbranch/team-contract/testing";
import { createTeamClient, type TeamClient } from "../src/index.js";
import type { TeamCatalogRowInput, TeamChangeBatchInput } from "../src/cache-adapter.js";
import {
  drainTeamOutbox,
  queueTeamCommand,
  syncWorkspace,
  TEAM_DRAIN_LEASE_MS,
  TeamOfflineQueueError,
  type TeamDrainResult,
  type TeamOutboxEntryView,
  type TeamOutboxStore,
  type TeamSyncCacheStore,
} from "../src/sync.js";
import type { FetchLike, TeamClock } from "../src/transport.js";

const seed = fixtures.catalogSeed;
const WORKSPACE_ID = seed.workspace.id;
const GENERATION = seed.workspace.membershipGeneration;
const EPOCH = seed.server.serverEpoch;
const PROMPT_ID = seed.prompts[0]!.prompt.id;
const HEAD_REVISION_ID = seed.prompts[0]!.prompt.approvedRevisionId;
const VIEWER_ID = seed.users.find((user) => user.role === "viewer")!.id;

const instantClock: TeamClock = { sleep: () => Promise.resolve(), random: () => 0.5 };

/** Mirrors Core's TeamCursorMismatchError structurally (packages/core/src/team/cache.ts). */
class MemoryCursorMismatchError extends Error {
  override readonly name = "TeamCursorMismatchError";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Team cursor mismatch: expected ${expected}, stored ${actual}`);
  }
}

interface MemoryStores {
  cache: TeamSyncCacheStore & { rows(): TeamCatalogRowInput[] };
  outbox: TeamOutboxStore & {
    entry(commandId: string): TeamOutboxEntryView | undefined;
    failNextAcknowledgement(): void;
  };
}

/**
 * In-memory store implementing the structural store interfaces with the same
 * semantics as Core's SQLite primitives: strict cursors, staging invisible
 * until activation, transactional lease with orphan recovery, and quarantine
 * moving queued/sending commands aside.
 */
function createMemoryStores(): MemoryStores {
  let cursor = "0";
  let serverEpoch: string | null = null;
  let membershipGeneration: string | null = null;
  let quarantineMarker: { reason: string; at: string } | null = null;
  let catalogRows: TeamCatalogRowInput[] = [];
  let stagedRows: TeamCatalogRowInput[] = [];
  let stagedSnapshotId: string | null = null;
  let lease: { holder: string; expiresAt: string } | null = null;
  const entries = new Map<string, TeamOutboxEntryView & { createdSeq: number }>();
  let createdSeq = 0;
  let failNextAck = false;

  const cache: MemoryStores["cache"] = {
    getCursor: () => cursor,
    getServerEpoch: () => serverEpoch,
    getMembershipGeneration: () => membershipGeneration,
    setServerEpoch: (epoch) => {
      serverEpoch = epoch;
    },
    setMembershipGeneration: (generation) => {
      membershipGeneration = generation;
    },
    applyChangeBatch(batch: TeamChangeBatchInput) {
      if (cursor !== batch.expectedCursor) throw new MemoryCursorMismatchError(batch.expectedCursor, cursor);
      for (const row of batch.upserts) {
        catalogRows = catalogRows.filter((existing) => !(existing.entity === row.entity && existing.id === row.id));
        catalogRows.push(row);
      }
      for (const tombstone of batch.deletes) {
        catalogRows = catalogRows.filter(
          (existing) => !(existing.entity === tombstone.entity && existing.id === tombstone.id),
        );
      }
      cursor = batch.nextCursor;
    },
    stageRows({ snapshotId, rows }) {
      if (stagedSnapshotId !== snapshotId) {
        stagedRows = [];
        stagedSnapshotId = snapshotId;
      }
      stagedRows.push(...rows);
    },
    activateCatalog({ snapshotId, highWater }) {
      if (stagedSnapshotId !== snapshotId) throw new Error(`No staged bootstrap snapshot ${snapshotId}`);
      catalogRows = stagedRows;
      stagedRows = [];
      stagedSnapshotId = null;
      cursor = highWater;
    },
    quarantine(reason: string) {
      catalogRows = [];
      stagedRows = [];
      stagedSnapshotId = null;
      cursor = "0";
      lease = null;
      for (const entry of entries.values()) {
        if (entry.state === "queued" || entry.state === "sending") entry.state = "quarantined";
      }
      quarantineMarker = { reason, at: new Date().toISOString() };
    },
    getQuarantine: () => quarantineMarker,
    clearQuarantine: () => {
      quarantineMarker = null;
    },
    rows: () => catalogRows,
  };

  const outbox: MemoryStores["outbox"] = {
    enqueueCommand({ commandId, requestJson, requestHash }) {
      const existing = entries.get(commandId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error("different request under an existing command id");
        return existing;
      }
      const entry: TeamOutboxEntryView & { createdSeq: number } = {
        commandId,
        requestJson,
        requestHash,
        state: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        receiptJson: null,
        errorJson: null,
        createdAt: new Date().toISOString(),
        createdSeq: ++createdSeq,
      };
      entries.set(commandId, entry);
      return entry;
    },
    acquireDrainLease({ holder, ttlMs, now }) {
      const at = now ?? new Date();
      if (lease && lease.expiresAt > at.toISOString()) return null;
      lease = { holder, expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      for (const entry of entries.values()) {
        if (entry.state === "sending") {
          entry.state = "queued";
          entry.nextAttemptAt = null;
        }
      }
      return lease;
    },
    renewDrainLease({ holder, ttlMs, now }) {
      if (!lease || lease.holder !== holder) return null;
      const at = now ?? new Date();
      lease = { holder, expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      return lease;
    },
    releaseDrainLease(holder) {
      if (lease?.holder === holder) lease = null;
    },
    claimDueCommands(input = {}) {
      const nowIso = (input.now ?? new Date()).toISOString();
      const due = [...entries.values()]
        .filter((entry) => entry.state === "queued" && (entry.nextAttemptAt === null || entry.nextAttemptAt <= nowIso))
        .sort((a, b) => a.createdSeq - b.createdSeq)
        .slice(0, input.limit ?? 50);
      for (const entry of due) entry.state = "sending";
      return due;
    },
    requeueCommand(commandId, input) {
      const entry = entries.get(commandId);
      if (!entry) throw new Error("unknown command");
      entry.state = "queued";
      if (input.countAttempt !== false) entry.attemptCount += 1;
      entry.nextAttemptAt = input.nextAttemptAt ? input.nextAttemptAt.toISOString() : null;
      entry.errorJson = input.errorJson ?? null;
      return entry;
    },
    acknowledgeCommand(commandId, receiptJson) {
      if (failNextAck) {
        failNextAck = false;
        throw new Error("simulated crash: acknowledgement was not persisted");
      }
      const entry = entries.get(commandId);
      if (!entry || entry.state !== "sending") throw new Error("not sending");
      entry.state = "acknowledged";
      entry.receiptJson = receiptJson;
      return entry;
    },
    failCommand(commandId, input) {
      const entry = entries.get(commandId);
      if (!entry) throw new Error("unknown command");
      entry.state = input.state;
      entry.errorJson = input.errorJson;
      return entry;
    },
    entry: (commandId) => entries.get(commandId),
    failNextAcknowledgement: () => {
      failNextAck = true;
    },
  };

  return { cache, outbox };
}

function clientFor(
  server: MockServerHandle,
  token: string | null,
  options: { fetchImpl?: FetchLike; maxAttempts?: number } = {},
): TeamClient {
  return createTeamClient({
    origin: server.origin,
    tokenSource: () => token,
    clock: instantClock,
    fetchImpl: options.fetchImpl,
    maxAttempts: options.maxAttempts,
  });
}

function envelope(operation: TeamOperation, commandId = randomUUID()): CommandEnvelope {
  return { commandId, membershipGeneration: GENERATION, operation };
}

function proposalSubmit(content: string, commandId = randomUUID()): CommandEnvelope {
  return envelope(
    {
      type: "proposal.submit",
      promptId: PROMPT_ID,
      baseRevisionId: HEAD_REVISION_ID,
      content,
      rationale: "Improve the structure.",
      supersedesProposalId: null,
    },
    commandId,
  );
}

function noteAdd(body: string, commandId = randomUUID()): CommandEnvelope {
  return envelope(
    { type: "note.add", promptId: PROMPT_ID, revisionId: HEAD_REVISION_ID, body },
    commandId,
  );
}

/** Wraps fetch to add a mock fault header to requests matched by `when`. */
function withFault(base: FetchLike, fault: MockFault, when: (url: string) => boolean): FetchLike {
  return (url, init) => {
    if (!when(url)) return base(url, init);
    const headers = new Headers(init.headers);
    headers.set(MOCK_FAULT_HEADER, fault);
    return base(url, { ...init, headers });
  };
}

function jsonError(status: number, code: string, retryable = false): Response {
  return new Response(JSON.stringify({ error: { code, message: code, requestId: randomUUID(), retryable } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("team sync and durable outbox", () => {
  let servers: MockServerHandle[];
  let server: MockServerHandle;

  async function spawn(options?: MockServerOptions): Promise<MockServerHandle> {
    const handle = await createMockServer(options);
    servers.push(handle);
    return handle;
  }

  beforeEach(async () => {
    servers = [];
    server = await spawn();
  });

  afterEach(async () => {
    for (const handle of servers) await handle.close();
  });

  describe("syncWorkspace", () => {
    it("bootstraps an empty cache through the snapshot and lands on the high-water cursor", async () => {
      const stores = createMemoryStores();
      const client = clientFor(server, MOCK_TOKENS.contributor);

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: true, cursor: fixtures.catalogChanges.baseSeq });
      // 2 tags + 1 collection + 2 prompts + 3 published revisions.
      expect(stores.cache.rows()).toHaveLength(8);
      expect(stores.cache.getServerEpoch()).toBe(EPOCH);
      expect(stores.cache.getMembershipGeneration()).toBe(GENERATION);
    });

    it("applies committed changes incrementally on top of the bootstrap", async () => {
      const stores = createMemoryStores();
      const client = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      const cursorBefore = stores.cache.getCursor();

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "feed-marker" }));

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: false, appliedChanges: 1 });
      expect(BigInt(stores.cache.getCursor())).toBe(BigInt(cursorBefore) + 1n);
      expect(stores.cache.rows().some((row) => row.entity === "tag" && row.json.includes("feed-marker"))).toBe(true);
    });

    it("treats a duplicate feed page delivery as a no-op (strict-cursor adaptation)", async () => {
      const stores = createMemoryStores();
      const client = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "duplicate-page" }));

      // Simulate a concurrent applier that already landed this exact page: the
      // first apply throws the Core mismatch shape with actual === nextCursor.
      const realApply = stores.cache.applyChangeBatch;
      let thrown = false;
      stores.cache.applyChangeBatch = (batch) => {
        if (!thrown) {
          thrown = true;
          throw new MemoryCursorMismatchError(batch.expectedCursor, batch.nextCursor);
        }
        realApply(batch);
      };

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status.kind).toBe("synced");
    });

    it("pauses on a cursor mismatch that is not a duplicate delivery", async () => {
      const stores = createMemoryStores();
      const client = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "mismatch" }));

      const cursorBefore = stores.cache.getCursor();
      stores.cache.applyChangeBatch = (batch) => {
        throw new MemoryCursorMismatchError(batch.expectedCursor, "0");
      };

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "paused", reason: "cursor-mismatch" });
      expect(stores.cache.getCursor()).toBe(cursorBefore);
    });

    it("pauses on a non-conforming feed event without advancing the cursor", async () => {
      const poisoned = await spawn({ faults: ["unknown-feed-event"] });
      const stores = createMemoryStores();
      const client = clientFor(poisoned, MOCK_TOKENS.owner);
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });

      await client.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "poison" }));
      const cacheCursorBefore = stores.cache.getCursor();

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "paused", reason: "invalid-response" });
      const cacheCursorAfterInvalidPage = stores.cache.getCursor();
      expect(cacheCursorAfterInvalidPage).toBe(cacheCursorBefore);
    });

    it("re-bootstraps when the feed reports CURSOR_EXPIRED, then catches up via the feed", async () => {
      const stores = createMemoryStores();
      const baseFetch = globalThis.fetch as FetchLike;
      let expireNextChanges = false;
      let expiredCalls = 0;
      const fetchImpl: FetchLike = (url, init) => {
        if (expireNextChanges && url.includes("/changes")) {
          expireNextChanges = false;
          expiredCalls += 1;
          return Promise.resolve(jsonError(410, "CURSOR_EXPIRED"));
        }
        return baseFetch(url, init);
      };
      const client = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl });
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(WORKSPACE_ID, EPOCH, envelope({ type: "tag.create", name: "after-expiry" }));

      expireNextChanges = true;
      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: true });
      // The reused snapshot's high-water predates the tag; the follow-up feed
      // pass in the same sync applies it.
      expect(BigInt(stores.cache.getCursor())).toBe(BigInt(fixtures.catalogChanges.baseSeq) + 1n);
      expect(stores.cache.rows().some((row) => row.json.includes("after-expiry"))).toBe(true);
      expect(expiredCalls).toBe(1);
    });

    it("restarts an expired bootstrap snapshot once and completes", async () => {
      const stores = createMemoryStores();
      const baseFetch = globalThis.fetch as FetchLike;
      let pageCalls = 0;
      let bootstrapPosts = 0;
      const fetchImpl: FetchLike = (url, init) => {
        if (url.includes("/bootstrap") && init.method === "POST") bootstrapPosts += 1;
        const once = url.includes("/bootstrap/") && init.method === "GET" && pageCalls++ === 0;
        return withFault(baseFetch, "expired-bootstrap", () => once)(url, init);
      };
      const client = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl });

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: true });
      expect(bootstrapPosts).toBe(2);
      expect(stores.cache.rows()).toHaveLength(8);
    });

    it("pauses without partial catalogue when snapshots keep expiring", async () => {
      const expiring = await spawn({ faults: ["expired-bootstrap"] });
      const stores = createMemoryStores();
      const client = clientFor(expiring, MOCK_TOKENS.contributor);

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "paused", reason: "snapshot-expired" });
      expect(stores.cache.getCursor()).toBe("0");
      expect(stores.cache.rows()).toHaveLength(0);
    });

    it("recovers from a server epoch reset by quarantining and re-bootstrapping", async () => {
      const stores = createMemoryStores();
      const clientA = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(clientA, stores.cache, { workspaceId: WORKSPACE_ID });
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("queued before the reset.\n", commandId));

      // Disaster restore: the same seed served under a new epoch.
      const seedB = { ...seed, server: { ...seed.server, serverEpoch: randomUUID() } };
      const serverB = await spawn({ seed: seedB });
      const clientB = clientFor(serverB, MOCK_TOKENS.contributor);

      const status = await syncWorkspace(clientB, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: true });
      expect(stores.cache.getServerEpoch()).toBe(seedB.server.serverEpoch);
      expect(stores.cache.rows()).toHaveLength(8);
      // Old queued mutations are quarantined and need deliberate resubmission;
      // the quarantine marker itself is cleared by the successful re-bootstrap.
      expect(stores.outbox.entry(commandId)!.state).toBe("quarantined");
      expect(stores.cache.getQuarantine()).toBeNull();
    });

    it("recovers from a membership generation change: refresh membership, quarantine commands, bootstrap", async () => {
      const stores = createMemoryStores();
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("queued before the role change.\n", commandId));

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "member.role", userId: VIEWER_ID, role: "contributor", expectedEntityVersion: 1 }),
      );

      const status = await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "synced", bootstrapped: true });
      expect(stores.cache.getMembershipGeneration()).not.toBe(GENERATION);
      expect(stores.outbox.entry(commandId)!.state).toBe("quarantined");
      expect(stores.cache.getQuarantine()).toBeNull();
      // The stale command was never delivered.
      expect(server.state.proposalCount).toBe(0);
    });

    it("clears the managed catalogue on WORKSPACE_FORBIDDEN and stays quarantined offline", async () => {
      const stores = createMemoryStores();
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("queued before removal.", commandId));
      expect(stores.cache.rows().length).toBeGreaterThan(0);

      // The member is removed: every subsequent workspace route returns 403.
      const baseFetch = globalThis.fetch as FetchLike;
      let calls = 0;
      const forbiddenFetch: FetchLike = (url, init) => {
        calls += 1;
        return withFault(baseFetch, "revoked-member", () => true)(url, init);
      };
      const removed = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: forbiddenFetch });

      const status = await syncWorkspace(removed, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "forbidden" });
      expect(stores.cache.rows()).toHaveLength(0);
      expect(stores.cache.getCursor()).toBe("0");
      expect(stores.outbox.entry(commandId)!.state).toBe("quarantined");
      expect(stores.cache.getQuarantine()).toMatchObject({ reason: "workspace-forbidden" });

      // A further sync serves the stored quarantine without touching the network.
      const callsBefore = calls;
      const again = await syncWorkspace(removed, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(again.kind).toBe("quarantined");
      expect(calls).toBe(callsBefore);
    });

    it("locks on SESSION_REVOKED and clears that principal's managed caches", async () => {
      const stores = createMemoryStores();
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });

      const revokedFetch: FetchLike = (url, init) =>
        url.includes("/changes")
          ? Promise.resolve(jsonError(401, "SESSION_REVOKED"))
          : (globalThis.fetch as FetchLike)(url, init);
      const client = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: revokedFetch });

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "locked", reason: "session-revoked" });
      expect(stores.cache.rows()).toHaveLength(0);
      expect(stores.cache.getQuarantine()).toMatchObject({ reason: "session-revoked" });
    });

    it("locks on ordinary 401 without destroying offline data", async () => {
      const stores = createMemoryStores();
      let token: string | null = MOCK_TOKENS.contributor;
      const client = createTeamClient({ origin: server.origin, tokenSource: () => token, clock: instantClock });
      await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      const rowsBefore = stores.cache.rows().length;
      const cursorBefore = stores.cache.getCursor();

      token = "pbtest_forged";
      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "locked", reason: "unauthenticated" });
      expect(stores.cache.rows()).toHaveLength(rowsBefore);
      expect(stores.cache.getCursor()).toBe(cursorBefore);
      expect(stores.cache.getQuarantine()).toBeNull();
    });

    it("keeps offline data on network errors", async () => {
      const stores = createMemoryStores();
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      const rowsBefore = stores.cache.rows().length;

      const offlineFetch: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
      const offline = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: offlineFetch, maxAttempts: 1 });
      const status = await syncWorkspace(offline, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status.kind).toBe("offline");
      expect(stores.cache.rows()).toHaveLength(rowsBefore);
      expect(stores.cache.getQuarantine()).toBeNull();
    });

    it("pauses on a malformed feed response without advancing the cursor", async () => {
      const stores = createMemoryStores();
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      const cursorBefore = stores.cache.getCursor();

      const garbageFetch: FetchLike = (url, init) =>
        url.includes("/changes")
          ? Promise.resolve(new Response("this is not json", { status: 200 }))
          : (globalThis.fetch as FetchLike)(url, init);
      const client = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: garbageFetch });

      const status = await syncWorkspace(client, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status).toMatchObject({ kind: "paused", reason: "invalid-response" });
      expect(stores.cache.getCursor()).toBe(cursorBefore);
    });
  });

  describe("queueTeamCommand", () => {
    it("queues only the four offline-capable operations with original bytes and hash", () => {
      const stores = createMemoryStores();
      const submitted = queueTeamCommand(stores.outbox, proposalSubmit("Queued body.\n"));
      expect(submitted.state).toBe("queued");
      expect(submitted.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(submitted.requestJson)).toMatchObject({ commandId: submitted.commandId });

      queueTeamCommand(
        stores.outbox,
        envelope({ type: "comment.add", proposalId: randomUUID(), body: "queued comment" }),
      );
      queueTeamCommand(stores.outbox, noteAdd("queued note"));
      queueTeamCommand(
        stores.outbox,
        envelope({
          type: "run.report",
          promptId: PROMPT_ID,
          revisionId: HEAD_REVISION_ID,
          body: "queued run",
          model: null,
          status: "completed",
          latencyMs: null,
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
        }),
      );
    });

    it("refuses to queue online-only operations", () => {
      const stores = createMemoryStores();
      const onlineOnly: TeamOperation[] = [
        {
          type: "proposal.review",
          proposalId: randomUUID(),
          expectedEntityVersion: 1,
          candidateRevisionId: randomUUID(),
          candidateContentHash: "0".repeat(64),
          expectedApprovedRevisionId: randomUUID(),
          decision: "approve",
          comment: "looks good",
        },
        { type: "prompt.rollback", promptId: PROMPT_ID, targetRevisionId: HEAD_REVISION_ID, expectedApprovedRevisionId: HEAD_REVISION_ID, reason: "revert" },
        { type: "prompt.archive", promptId: PROMPT_ID, expectedEntityVersion: 1 },
        {
          type: "prompt.metadata",
          promptId: PROMPT_ID,
          title: "new title",
          description: "new description",
          tagIds: [],
          collectionIds: [],
          expectedEntityVersion: 1,
        },
        { type: "member.remove", userId: VIEWER_ID, expectedEntityVersion: 1 },
      ];
      for (const operation of onlineOnly) {
        expect(() => queueTeamCommand(stores.outbox, envelope(operation))).toThrowError(TeamOfflineQueueError);
      }
      // Nothing was queued.
      expect(stores.outbox.claimDueCommands({ now: new Date("2099-01-01") })).toEqual([]);
    });
  });

  describe("drainTeamOutbox", () => {
    function syncedStores(): MemoryStores {
      const stores = createMemoryStores();
      stores.cache.setServerEpoch(EPOCH);
      stores.cache.setMembershipGeneration(GENERATION);
      return stores;
    }

    async function drain(
      client: TeamClient,
      stores: MemoryStores,
      options: { holder?: string; now?: () => Date } = {},
    ): Promise<TeamDrainResult> {
      return drainTeamOutbox(client, stores, {
        workspaceId: WORKSPACE_ID,
        holder: options.holder ?? "drainer",
        now: options.now,
        random: () => 0.5,
      });
    }

    it("drains a queued proposal submission and stores the receipt", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("Submitted from the outbox.\n", commandId));

      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      const result = await drain(contributor, stores);
      expect(result.kind).toBe("drained");
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({ commandId, result: { kind: "proposal" } });

      const entry = stores.outbox.entry(commandId)!;
      expect(entry.state).toBe("acknowledged");
      expect(entry.receiptJson).toContain(result.receipts[0]!.result.id);
      expect(server.state.proposalCount).toBe(1);
    });

    it("survives a lost response after commit and a restart: one proposal, replayed receipt", async () => {
      const dropping = await spawn({ faults: ["drop-response-after-commit"] });
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("Retried after a lost response.\n", commandId));

      // First process: the response is dropped after commit; the transport's
      // retry replays the receipt, but the process crashes before persisting
      // the acknowledgement.
      stores.outbox.failNextAcknowledgement();
      const first = await drain(clientFor(dropping, MOCK_TOKENS.contributor), stores, { holder: "process-a" });
      expect(first.kind).toBe("paused");
      expect(stores.outbox.entry(commandId)!.state).toBe("sending");

      // Restarted process: recovers the orphaned send and re-delivers under the
      // same command id; the server replays the original receipt.
      const second = await drain(clientFor(dropping, MOCK_TOKENS.contributor), stores, { holder: "process-b" });
      expect(second.kind).toBe("drained");

      const receipts = [...first.receipts, ...second.receipts];
      const proposalId = receipts[0]!.result.id;
      expect(receipts.map((r) => r.result.id)).toEqual([proposalId, proposalId]);
      expect(dropping.state.proposalCount).toBe(1);
      expect(dropping.state.receiptCount).toBe(1);
      expect(stores.outbox.entry(commandId)!.state).toBe("acknowledged");
    });

    it("recovers an expired sending lease as queued with the same command id", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("claimed by a crashed process.", commandId));

      const t0 = new Date("2026-09-21T12:00:00.000Z");
      // A crashed drainer: lease acquired, command claimed, never released.
      stores.outbox.acquireDrainLease({ holder: "crashed", ttlMs: TEAM_DRAIN_LEASE_MS, now: t0 });
      expect(stores.outbox.claimDueCommands({ now: t0 })).toHaveLength(1);
      expect(stores.outbox.entry(commandId)!.state).toBe("sending");

      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      // While the crashed lease is still live, a second drainer is refused.
      const early = await drain(contributor, stores, {
        holder: "successor",
        now: () => new Date(t0.getTime() + 10_000),
      });
      expect(early).toMatchObject({ kind: "skipped", reason: "lease-held" });

      // After lease expiry the successor recovers and delivers the command.
      const late = await drain(contributor, stores, {
        holder: "successor",
        now: () => new Date(t0.getTime() + TEAM_DRAIN_LEASE_MS + 1_000),
      });
      expect(late.kind).toBe("drained");
      expect(late.receipts.map((receipt) => receipt.commandId)).toEqual([commandId]);
      expect(stores.outbox.entry(commandId)!.state).toBe("acknowledged");
    });

    it("lets only one of two drainers sharing a cache run at a time", async () => {
      const stores = syncedStores();
      queueTeamCommand(stores.outbox, noteAdd("contended drain."));
      queueTeamCommand(stores.outbox, noteAdd("contended drain 2."));

      const baseFetch = globalThis.fetch as FetchLike;
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let commandCalls = 0;
      const gatingFetch: FetchLike = async (url, init) => {
        if (url.includes("/commands") && commandCalls++ === 0) await gate;
        return baseFetch(url, init);
      };
      const contributor = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: gatingFetch });

      const first = drain(contributor, stores, { holder: "first" });
      // Give the first drainer a chance to acquire the lease and open the request.
      await vi.waitFor(() => expect(commandCalls).toBe(1));

      const secondResult = await drain(contributor, stores, { holder: "second" });
      expect(secondResult).toMatchObject({ kind: "skipped", reason: "lease-held" });

      releaseFirst();
      const firstResult = await first;
      expect(firstResult.kind).toBe("drained");
      expect(firstResult.receipts).toHaveLength(2);
    });

    it("schedules a backoff retry on retryable server errors and later succeeds", async () => {
      const stores = syncedStores();
      const now = new Date("2026-09-21T12:00:00.000Z");
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("retry me.", commandId));

      let failing = true;
      const baseFetch = globalThis.fetch as FetchLike;
      const flakyFetch: FetchLike = (url, init) =>
        url.includes("/commands") && failing
          ? Promise.resolve(jsonError(503, "UNAVAILABLE", true))
          : baseFetch(url, init);
      const contributor = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: flakyFetch });

      const first = await drain(contributor, stores, { now: () => now });
      expect(first.kind).toBe("retry-later");
      const entry = stores.outbox.entry(commandId)!;
      expect(entry.state).toBe("queued");
      expect(entry.attemptCount).toBe(1);
      // 1 s base backoff with random() = 0.5 → factor 1.0.
      expect(entry.nextAttemptAt).toBe(new Date(now.getTime() + 1_000).toISOString());

      failing = false;
      const second = await drain(contributor, stores, { now: () => new Date(now.getTime() + 2_000) });
      expect(second.kind).toBe("drained");
      expect(stores.outbox.entry(commandId)!.state).toBe("acknowledged");
    });

    it("marks stale commands as conflict and keeps draining the rest", async () => {
      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      const owner = clientFor(server, MOCK_TOKENS.owner);
      const maintainer = clientFor(server, MOCK_TOKENS.maintainer);

      // An online proposal that will be approved before the queued supersede drains.
      const submitted = await contributor.command(WORKSPACE_ID, EPOCH, proposalSubmit("Original candidate.\n"));
      const proposalId = submitted.result.id;

      const stores = syncedStores();
      const staleId = randomUUID();
      queueTeamCommand(
        stores.outbox,
        envelope(
          {
            type: "proposal.submit",
            promptId: PROMPT_ID,
            baseRevisionId: HEAD_REVISION_ID,
            content: "Superseding candidate.\n",
            rationale: "Supersede the original.",
            supersedesProposalId: proposalId,
          },
          staleId,
        ),
      );
      const okId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("still deliverable.", okId));

      const detail = await owner.getProposal(WORKSPACE_ID, proposalId);
      await maintainer.command(
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
          comment: "Approved.",
        }),
      );

      const result = await drain(contributor, stores);
      expect(result.kind).toBe("drained");
      expect(result.receipts).toHaveLength(1);
      expect(stores.outbox.entry(staleId)).toMatchObject({ state: "conflict" });
      expect(JSON.parse(stores.outbox.entry(staleId)!.errorJson!)).toMatchObject({ code: "STALE_ENTITY" });
      expect(stores.outbox.entry(okId)!.state).toBe("acknowledged");
    });

    it("marks invalid commands as rejected without retrying them", async () => {
      const stores = syncedStores();
      const invalidId = randomUUID();
      // note.add against a revision that was never published.
      queueTeamCommand(
        stores.outbox,
        envelope(
          { type: "note.add", promptId: PROMPT_ID, revisionId: randomUUID(), body: "dangling revision." },
          invalidId,
        ),
      );

      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      const result = await drain(contributor, stores);
      expect(result.kind).toBe("drained");
      expect(result.receipts).toEqual([]);
      expect(stores.outbox.entry(invalidId)).toMatchObject({ state: "rejected" });
      expect(JSON.parse(stores.outbox.entry(invalidId)!.errorJson!)).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("marks forbidden commands as rejected without clearing the catalogue", async () => {
      const stores = syncedStores();
      const forbiddenId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("Viewer cannot submit.\n", forbiddenId));

      const viewer = clientFor(server, MOCK_TOKENS.viewer);
      const result = await drain(viewer, stores);
      expect(result.kind).toBe("drained");
      expect(result.receipts).toEqual([]);
      expect(stores.outbox.entry(forbiddenId)).toMatchObject({ state: "rejected" });
      expect(JSON.parse(stores.outbox.entry(forbiddenId)!.errorJson!)).toMatchObject({ code: "ROLE_FORBIDDEN" });
      // ROLE_FORBIDDEN rejects the action only; the store is not quarantined.
      expect(stores.cache.getQuarantine()).toBeNull();
    });

    it("stops at the first retryable failure to preserve dependency ordering", async () => {
      const stores = syncedStores();
      const firstId = randomUUID();
      const secondId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("first in line.", firstId));
      queueTeamCommand(stores.outbox, noteAdd("depends on the first.", secondId));

      const baseFetch = globalThis.fetch as FetchLike;
      const flakyFetch: FetchLike = (url, init) => {
        if (url.includes("/commands") && typeof init.body === "string" && init.body.includes(firstId)) {
          return Promise.resolve(jsonError(503, "UNAVAILABLE", true));
        }
        return baseFetch(url, init);
      };
      const contributor = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: flakyFetch });

      const result = await drain(contributor, stores);
      expect(result.kind).toBe("retry-later");
      expect(stores.outbox.entry(firstId)).toMatchObject({ state: "queued", attemptCount: 1 });
      // The dependent command was never attempted.
      expect(stores.outbox.entry(secondId)).toMatchObject({ state: "queued", attemptCount: 0 });
      expect(result.receipts).toEqual([]);
    });

    it("requeues without penalty and locks when the credential disappears", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("needs a login.", commandId));

      const loggedOut = clientFor(server, null);
      const result = await drain(loggedOut, stores);
      expect(result).toMatchObject({ kind: "locked", reason: "unauthenticated" });
      expect(stores.outbox.entry(commandId)).toMatchObject({
        state: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
      });
    });

    it("quarantines the store when the workspace forbids the caller mid-drain", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("about to be quarantined.", commandId));

      const baseFetch = globalThis.fetch as FetchLike;
      const removed = clientFor(server, MOCK_TOKENS.contributor, {
        fetchImpl: withFault(baseFetch, "revoked-member", () => true),
      });

      const result = await drain(removed, stores);
      expect(result.kind).toBe("forbidden");
      expect(stores.outbox.entry(commandId)!.state).toBe("quarantined");
      expect(stores.cache.getQuarantine()).toMatchObject({ reason: "workspace-forbidden" });
    });

    it("asks for a resync when the server reports a generation change mid-drain", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, proposalSubmit("queued before rotation.\n", commandId));

      const owner = clientFor(server, MOCK_TOKENS.owner);
      await owner.command(
        WORKSPACE_ID,
        EPOCH,
        envelope({ type: "member.role", userId: VIEWER_ID, role: "contributor", expectedEntityVersion: 1 }),
      );

      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      const result = await drain(contributor, stores);
      expect(result).toMatchObject({ kind: "sync-required", reason: "membership-changed" });
      // The command was not consumed server-side and stays queued locally.
      expect(stores.outbox.entry(commandId)).toMatchObject({ state: "queued", attemptCount: 0 });

      // Following up with a sync quarantines it and re-bootstraps.
      const status = await syncWorkspace(contributor, stores.cache, { workspaceId: WORKSPACE_ID });
      expect(status.kind).toBe("synced");
      expect(stores.outbox.entry(commandId)!.state).toBe("quarantined");
    });

    it("rejects a malformed stored envelope without sending it", async () => {
      const stores = syncedStores();
      const commandId = randomUUID();
      stores.outbox.enqueueCommand({
        commandId,
        requestJson: "this is not json",
        requestHash: "b".repeat(64),
      });

      const baseFetch = globalThis.fetch as FetchLike;
      let commandCalls = 0;
      const countingFetch: FetchLike = (url, init) => {
        if (url.includes("/commands")) commandCalls += 1;
        return baseFetch(url, init);
      };
      const contributor = clientFor(server, MOCK_TOKENS.contributor, { fetchImpl: countingFetch });

      const result = await drain(contributor, stores);
      expect(result.kind).toBe("drained");
      expect(stores.outbox.entry(commandId)!.state).toBe("rejected");
      expect(commandCalls).toBe(0);
    });

    it("asks for a sync first when the store has never been synced", async () => {
      const stores = createMemoryStores();
      const commandId = randomUUID();
      queueTeamCommand(stores.outbox, noteAdd("no epoch yet.", commandId));

      const contributor = clientFor(server, MOCK_TOKENS.contributor);
      const result = await drain(contributor, stores);
      expect(result).toMatchObject({ kind: "sync-required", reason: "never-synced" });
      expect(stores.outbox.entry(commandId)).toMatchObject({ state: "queued", attemptCount: 0 });
    });
  });
});
