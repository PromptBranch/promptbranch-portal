import { createHash } from "node:crypto";
import {
  commandEnvelopeSchema,
  type BootstrapStart,
  type ChangesPage,
  type CommandEnvelope,
  type CommandReceipt,
} from "@promptbranch/team-contract";
import {
  bootstrapPageToRows,
  changesPageToBatch,
  type TeamCatalogRowInput,
  type TeamChangeBatchInput,
} from "./cache-adapter.js";
import type { TeamClient } from "./client.js";
import { isRetryableApiError, TeamApiError, TeamTransportError } from "./errors.js";

/**
 * Resumable catalogue sync and the durable command outbox drain (C6/C7).
 *
 * Both entry points are storage-agnostic: they drive structural store
 * interfaces that `@promptbranch/core` satisfies via `createTeamCacheStore` /
 * `createTeamOutboxStore` (packages/core/src/team/store.ts — the two packages
 * cannot import each other, so the contract is structural and both sides
 * cross-reference this note). The stores own atomicity: row effects and
 * cursor movement commit together, and a duplicate feed page surfaces as a
 * `TeamCursorMismatchError`-shaped error whose `actual` equals the batch's
 * `nextCursor`, which this layer treats as a no-op (C7 duplicate delivery).
 */

export const TEAM_DRAIN_LEASE_MS = 30_000;
export const TEAM_DRAIN_RENEW_MS = 10_000;
export const TEAM_PAGE_LIMIT = 100;

const DRAIN_BACKOFF_BASE_MS = 1_000;
const DRAIN_BACKOFF_MAX_MS = 60_000;

/**
 * The only operations that may be queued while offline (plan/C6): content
 * contributions whose failure modes are safe to surface later. Review,
 * rollback, archive, metadata and membership actions require online execution
 * against current permissions and are refused here.
 */
export const OFFLINE_QUEUEABLE_OPERATIONS = [
  "proposal.submit",
  "comment.add",
  "note.add",
  "run.report",
] as const;

export type OfflineQueueableOperation = (typeof OFFLINE_QUEUEABLE_OPERATIONS)[number];

export class TeamOfflineQueueError extends Error {
  override readonly name = "TeamOfflineQueueError";
  constructor(readonly operationType: string) {
    super(`Operation ${operationType} requires online execution and cannot be queued offline`);
  }
}

export function isOfflineQueueableOperation(type: string): type is OfflineQueueableOperation {
  return (OFFLINE_QUEUEABLE_OPERATIONS as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Structural store interfaces (satisfied by Core's createTeam*Store).
// ---------------------------------------------------------------------------

export interface TeamSyncCacheStore {
  getCursor(): string;
  getServerEpoch(): string | null;
  getMembershipGeneration(): string | null;
  setServerEpoch(epoch: string): void;
  setMembershipGeneration(generation: string): void;
  /** Atomic: row effects and cursor advancement commit together or not at all. */
  applyChangeBatch(batch: TeamChangeBatchInput): void;
  stageRows(input: { snapshotId: string; rows: TeamCatalogRowInput[] }): void;
  /** Swaps the staged snapshot into the live catalogue and moves the cursor to highWater. */
  activateCatalog(input: { snapshotId: string; highWater: string }): void;
  quarantine(reason: string): void;
  getQuarantine(): { reason: string; at: string } | null;
  clearQuarantine(): void;
}

export type TeamOutboxEntryState = "queued" | "sending" | "acknowledged" | "conflict" | "rejected" | "quarantined";

export interface TeamOutboxEntryView {
  commandId: string;
  requestJson: string;
  requestHash: string;
  state: TeamOutboxEntryState;
  attemptCount: number;
  nextAttemptAt: string | null;
  receiptJson: string | null;
  errorJson: string | null;
  createdAt: string;
}

export interface TeamDrainLeaseView {
  holder: string;
  expiresAt: string;
}

export interface TeamOutboxStore {
  enqueueCommand(input: { commandId: string; requestJson: string; requestHash: string }): TeamOutboxEntryView;
  /** Null while another holder's lease is live. A successful acquire recovers orphaned sends to queued. */
  acquireDrainLease(input: { holder: string; ttlMs: number; now?: Date }): TeamDrainLeaseView | null;
  renewDrainLease(input: { holder: string; ttlMs: number; now?: Date }): TeamDrainLeaseView | null;
  releaseDrainLease(holder: string): void;
  /** Moves due queued entries to sending, in submission order. */
  claimDueCommands(input?: { now?: Date; limit?: number }): TeamOutboxEntryView[];
  requeueCommand(
    commandId: string,
    input: { nextAttemptAt: Date | null; errorJson?: string | null; countAttempt?: boolean },
  ): unknown;
  acknowledgeCommand(commandId: string, receiptJson: string): unknown;
  failCommand(commandId: string, input: { state: "conflict" | "rejected"; errorJson: string }): unknown;
}

// ---------------------------------------------------------------------------
// Offline queueing
// ---------------------------------------------------------------------------

/**
 * Queues a validated command for durable delivery. The original request bytes
 * and their SHA-256 are persisted so a restart resends exactly what the user
 * submitted, and so the store can reject a changed payload under an existing
 * command id (mirroring the server's receipt rule, C6). Enqueue is idempotent
 * per command id.
 */
export function queueTeamCommand(outbox: TeamOutboxStore, envelope: CommandEnvelope): TeamOutboxEntryView {
  const parsed = commandEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new TeamTransportError("invalid-request", "The command envelope failed contract validation.");
  }
  if (!isOfflineQueueableOperation(parsed.data.operation.type)) {
    throw new TeamOfflineQueueError(parsed.data.operation.type);
  }
  const requestJson = JSON.stringify(parsed.data);
  const requestHash = createHash("sha256").update(requestJson, "utf8").digest("hex");
  return outbox.enqueueCommand({ commandId: parsed.data.commandId, requestJson, requestHash });
}

// ---------------------------------------------------------------------------
// Catalogue sync (C7)
// ---------------------------------------------------------------------------

export interface SyncWorkspaceOptions {
  workspaceId: string;
  signal?: AbortSignal;
  /** Change-feed page size; defaults to the protocol maximum. */
  changesLimit?: number;
  /** Bootstrap page size; defaults to the protocol maximum. */
  bootstrapLimit?: number;
}

export type TeamSyncStatus =
  | { kind: "synced"; cursor: string; bootstrapped: boolean; appliedChanges: number }
  | { kind: "quarantined"; quarantine: { reason: string; at: string } }
  | { kind: "paused"; reason: "invalid-response" | "snapshot-expired" | "cursor-mismatch"; cursor: string }
  | { kind: "offline"; cursor: string }
  | { kind: "retry-later"; cursor: string }
  | { kind: "locked"; reason: "unauthenticated" | "session-revoked" }
  | { kind: "forbidden" };

/**
 * Core's strict cursor check (TeamCursorMismatchError) reaches us
 * structurally; the two packages cannot share a class. A mismatch whose
 * stored cursor already equals the batch's target is a duplicate delivery of
 * an applied page — a no-op per C7.
 */
function isDuplicateDelivery(error: unknown, nextCursor: string): boolean {
  return (
    error instanceof Error &&
    error.name === "TeamCursorMismatchError" &&
    (error as { actual?: unknown }).actual === nextCursor
  );
}

function isCursorMismatch(error: unknown): boolean {
  return error instanceof Error && error.name === "TeamCursorMismatchError";
}

function isApiError(error: unknown, code: string): boolean {
  return error instanceof TeamApiError && error.code === code;
}

/**
 * Maps a failure to a terminal sync status, applying the C6 side effects:
 * WORKSPACE_FORBIDDEN quarantines and clears the managed catalogue,
 * SESSION_REVOKED quarantines and locks, ordinary 401 only locks, and network
 * errors retain everything. Recoverable codes (cursor/snapshot expiry,
 * membership and epoch changes) return undefined and are handled by the
 * caller. Caller aborts propagate.
 */
function terminalSyncError(error: unknown, cache: TeamSyncCacheStore): TeamSyncStatus | undefined {
  if (error instanceof TeamTransportError) {
    switch (error.reason) {
      case "aborted":
        throw error;
      case "network":
      case "timeout":
        return { kind: "offline", cursor: cache.getCursor() };
      case "not-authenticated":
      case "invalid-token":
        return { kind: "locked", reason: "unauthenticated" };
      default:
        // invalid-response/invalid-json/response-too-large/redirect-refused/
        // unsupported-server: pause without advancing the cursor (C2).
        return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
    }
  }
  if (error instanceof TeamApiError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
        return { kind: "locked", reason: "unauthenticated" };
      case "SESSION_REVOKED":
        cache.quarantine("session-revoked");
        return { kind: "locked", reason: "session-revoked" };
      case "WORKSPACE_FORBIDDEN":
        cache.quarantine("workspace-forbidden");
        return { kind: "forbidden" };
      case "CURSOR_EXPIRED":
      case "SNAPSHOT_EXPIRED":
      case "MEMBERSHIP_CHANGED":
      case "SERVER_EPOCH_CHANGED":
        return undefined;
      default:
        if (isRetryableApiError(error)) return { kind: "retry-later", cursor: cache.getCursor() };
        return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
    }
  }
  // Store-side row validation failures are wire problems: pause, keep cursor.
  return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
}

/**
 * One sync pass: bootstrap when there is no usable cursor, otherwise apply
 * the change feed. A stored quarantine marker short-circuits without any
 * network traffic — re-entry requires a fresh bootstrap driven by a context
 * change (membership/epoch recovery), never silent re-upload.
 */
export async function syncWorkspace(
  client: TeamClient,
  cache: TeamSyncCacheStore,
  options: SyncWorkspaceOptions,
): Promise<TeamSyncStatus> {
  const quarantined = cache.getQuarantine();
  if (quarantined) return { kind: "quarantined", quarantine: quarantined };

  // Per-pass guards against a pathological server rotating underneath us.
  let reBootstrapped = false;
  let recoveries = 0;

  async function resolveContext(): Promise<TeamSyncStatus | null> {
    let workspace;
    try {
      workspace = await client.getWorkspace(options.workspaceId, { signal: options.signal });
    } catch (error) {
      const status = terminalSyncError(error, cache);
      if (status) return status;
      throw error;
    }
    cache.setServerEpoch(workspace.serverEpoch);
    cache.setMembershipGeneration(workspace.membershipGeneration);
    return null;
  }

  /** Membership/epoch rotation: re-resolve, quarantine stale work, re-bootstrap (C6). */
  async function recoverMembership(reason: "membership-changed" | "server-epoch-changed"): Promise<TeamSyncStatus> {
    recoveries += 1;
    if (recoveries > 2) return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
    const failed = await resolveContext();
    if (failed) return failed;
    cache.quarantine(reason);
    return bootstrapThenFeed();
  }

  async function bootstrapThenFeed(): Promise<TeamSyncStatus> {
    reBootstrapped = true;
    const boot = await bootstrapFlow();
    if (boot.kind !== "synced") return boot;
    // A reused snapshot can lag the live feed; catch up in the same pass.
    const feed = await feedFlow();
    return feed.kind === "synced" ? { ...feed, bootstrapped: true } : feed;
  }

  async function bootstrapFlow(): Promise<TeamSyncStatus> {
    let restarts = 0;
    for (;;) {
      let start: BootstrapStart;
      try {
        start = await client.bootstrap(
          options.workspaceId,
          {
            membershipGeneration: cache.getMembershipGeneration()!,
            serverEpoch: cache.getServerEpoch()!,
          },
          { signal: options.signal },
        );
      } catch (error) {
        if (isApiError(error, "MEMBERSHIP_CHANGED")) return recoverMembership("membership-changed");
        if (isApiError(error, "SERVER_EPOCH_CHANGED")) return recoverMembership("server-epoch-changed");
        const status = terminalSyncError(error, cache);
        if (status) return status;
        throw error;
      }

      let pageToken: string | undefined;
      let failed: TeamSyncStatus | "restart" | null = null;
      for (;;) {
        try {
          const page = await client.bootstrapPage(
            options.workspaceId,
            start.snapshotId,
            { pageToken, limit: options.bootstrapLimit ?? TEAM_PAGE_LIMIT },
            { signal: options.signal },
          );
          if (page.snapshotId !== start.snapshotId) {
            throw new TeamTransportError("invalid-response", "A bootstrap page named a different snapshot.");
          }
          cache.stageRows({ snapshotId: start.snapshotId, rows: bootstrapPageToRows(page) });
          if (page.nextPageToken === null) break;
          pageToken = page.nextPageToken;
        } catch (error) {
          if (isApiError(error, "SNAPSHOT_EXPIRED")) {
            failed = "restart";
          } else if (isApiError(error, "MEMBERSHIP_CHANGED")) {
            return recoverMembership("membership-changed");
          } else if (isApiError(error, "SERVER_EPOCH_CHANGED")) {
            return recoverMembership("server-epoch-changed");
          } else {
            failed = terminalSyncError(error, cache) ?? {
              kind: "paused",
              reason: "invalid-response",
              cursor: cache.getCursor(),
            };
          }
          break;
        }
      }

      if (failed === "restart") {
        restarts += 1;
        if (restarts > 1) return { kind: "paused", reason: "snapshot-expired", cursor: cache.getCursor() };
        continue;
      }
      if (failed) return failed;

      try {
        cache.activateCatalog({ snapshotId: start.snapshotId, highWater: start.highWater });
      } catch {
        // A bad snapshot leaves the existing catalogue and cursor untouched.
        return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
      }
      // Re-bootstrap completed: lift the quarantine marker. Quarantined
      // commands/drafts stay quarantined pending deliberate resubmission.
      cache.clearQuarantine();
      return { kind: "synced", cursor: cache.getCursor(), bootstrapped: true, appliedChanges: 0 };
    }
  }

  async function feedFlow(): Promise<TeamSyncStatus> {
    let appliedChanges = 0;
    for (;;) {
      const after = cache.getCursor();
      let page: ChangesPage;
      try {
        page = await client.changes(
          options.workspaceId,
          {
            after,
            serverEpoch: cache.getServerEpoch()!,
            membershipGeneration: cache.getMembershipGeneration()!,
            limit: options.changesLimit ?? TEAM_PAGE_LIMIT,
          },
          { signal: options.signal },
        );
      } catch (error) {
        if (isApiError(error, "CURSOR_EXPIRED")) {
          // A cursor that expires immediately after this pass's own
          // re-bootstrap is a broken server, not a reason to loop.
          if (reBootstrapped) return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
          return bootstrapThenFeed();
        }
        if (isApiError(error, "MEMBERSHIP_CHANGED")) return recoverMembership("membership-changed");
        if (isApiError(error, "SERVER_EPOCH_CHANGED")) return recoverMembership("server-epoch-changed");
        const status = terminalSyncError(error, cache);
        if (status) return status;
        throw error;
      }
      // A page echoing a different epoch/generation means the server rotated
      // underneath us between requests.
      if (page.serverEpoch !== cache.getServerEpoch()) return recoverMembership("server-epoch-changed");
      if (page.membershipGeneration !== cache.getMembershipGeneration()) {
        return recoverMembership("membership-changed");
      }

      try {
        const batch = changesPageToBatch(page, after);
        if (batch) {
          cache.applyChangeBatch(batch);
          appliedChanges += page.changes.length;
        }
      } catch (error) {
        if (isDuplicateDelivery(error, page.nextCursor)) {
          // Already applied by a concurrent/previous pass: no-op (C7).
        } else if (isCursorMismatch(error)) {
          return { kind: "paused", reason: "cursor-mismatch", cursor: cache.getCursor() };
        } else {
          return { kind: "paused", reason: "invalid-response", cursor: cache.getCursor() };
        }
      }
      if (!page.hasMore) {
        return { kind: "synced", cursor: cache.getCursor(), bootstrapped: false, appliedChanges };
      }
    }
  }

  if (!cache.getServerEpoch() || !cache.getMembershipGeneration()) {
    const failed = await resolveContext();
    if (failed) return failed;
  }

  return cache.getCursor() === "0" ? bootstrapThenFeed() : feedFlow();
}

// ---------------------------------------------------------------------------
// Outbox drain (C6)
// ---------------------------------------------------------------------------

export interface DrainTeamOutboxOptions {
  workspaceId: string;
  /** Unique identity of this drainer (e.g. process-scoped) for the lease. */
  holder: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Jitter source for retry backoff; defaults to Math.random. */
  random?: () => number;
  leaseMs?: number;
  renewMs?: number;
}

export type TeamDrainResult =
  | { kind: "drained"; receipts: CommandReceipt[] }
  | { kind: "skipped"; reason: "lease-held"; receipts: CommandReceipt[] }
  | { kind: "offline"; receipts: CommandReceipt[] }
  | { kind: "retry-later"; receipts: CommandReceipt[] }
  | { kind: "paused"; reason: "invalid-response" | "store-error"; receipts: CommandReceipt[] }
  | { kind: "locked"; reason: "unauthenticated" | "session-revoked"; receipts: CommandReceipt[] }
  | { kind: "forbidden"; receipts: CommandReceipt[] }
  | {
      kind: "sync-required";
      reason: "membership-changed" | "server-epoch-changed" | "never-synced";
      receipts: CommandReceipt[];
    }
  | { kind: "interrupted"; reason: "lease-lost"; receipts: CommandReceipt[] };

const CONFLICT_CODES = new Set(["STALE_BASE", "STALE_ENTITY", "SELF_REVIEW", "LAST_OWNER", "COMMAND_ID_REUSED"]);

function errorJson(error: TeamApiError | TeamTransportError): string {
  return JSON.stringify(
    error instanceof TeamApiError
      ? { code: error.code, message: error.message }
      : { reason: error.reason, message: error.message },
  );
}

/**
 * Delivers queued commands in submission order under a transactional lease.
 * State transitions are separate short store transactions around each HTTP
 * call — a transaction is never held across the network. Terminal failures
 * (409 conflicts, 422/403 rejections) are recorded and skipped; retryable
 * failures stop the drain so later commands that may depend on them are never
 * reordered. The lease is renewed every `renewMs` while draining.
 */
export async function drainTeamOutbox(
  client: TeamClient,
  stores: { cache: TeamSyncCacheStore; outbox: TeamOutboxStore },
  options: DrainTeamOutboxOptions,
): Promise<TeamDrainResult> {
  const { cache, outbox } = stores;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const leaseMs = options.leaseMs ?? TEAM_DRAIN_LEASE_MS;
  const renewMs = options.renewMs ?? TEAM_DRAIN_RENEW_MS;
  const receipts: CommandReceipt[] = [];

  const lease = outbox.acquireDrainLease({ holder: options.holder, ttlMs: leaseMs, now: now() });
  if (!lease) return { kind: "skipped", reason: "lease-held", receipts };

  const backoffAt = (attemptCount: number, retryAfterMs?: number): Date => {
    const base = Math.min(DRAIN_BACKOFF_MAX_MS, DRAIN_BACKOFF_BASE_MS * 2 ** attemptCount);
    const delay = retryAfterMs ?? Math.min(DRAIN_BACKOFF_MAX_MS, Math.round(base * (0.5 + random())));
    return new Date(now().getTime() + delay);
  };

  let leaseRenewedAt = now().getTime();
  try {
    const epoch = cache.getServerEpoch();
    if (epoch === null) return { kind: "sync-required", reason: "never-synced", receipts };

    for (;;) {
      if (now().getTime() - leaseRenewedAt >= renewMs) {
        const renewed = outbox.renewDrainLease({ holder: options.holder, ttlMs: leaseMs, now: now() });
        if (!renewed) return { kind: "interrupted", reason: "lease-lost", receipts };
        leaseRenewedAt = now().getTime();
      }

      const entry = outbox.claimDueCommands({ now: now(), limit: 1 })[0];
      if (!entry) return { kind: "drained", receipts };

      let parsed: CommandEnvelope;
      try {
        parsed = commandEnvelopeSchema.parse(JSON.parse(entry.requestJson));
      } catch {
        // A malformed stored envelope can never succeed; reject it locally.
        outbox.failCommand(entry.commandId, {
          state: "rejected",
          errorJson: JSON.stringify({ code: "INVALID_STORED_REQUEST", message: "The stored command is not a valid envelope." }),
        });
        continue;
      }

      let receipt: CommandReceipt;
      try {
        receipt = await client.command(options.workspaceId, epoch, parsed, { signal: options.signal });
      } catch (error) {
        if (error instanceof TeamTransportError) {
          switch (error.reason) {
            case "aborted":
              outbox.requeueCommand(entry.commandId, { nextAttemptAt: null, countAttempt: false });
              throw error;
            case "not-authenticated":
            case "invalid-token":
              outbox.requeueCommand(entry.commandId, { nextAttemptAt: null, countAttempt: false });
              return { kind: "locked", reason: "unauthenticated", receipts };
            case "network":
            case "timeout":
              outbox.requeueCommand(entry.commandId, {
                nextAttemptAt: backoffAt(entry.attemptCount),
                errorJson: errorJson(error),
              });
              return { kind: "offline", receipts };
            case "invalid-request":
              outbox.failCommand(entry.commandId, { state: "rejected", errorJson: errorJson(error) });
              continue;
            default:
              outbox.requeueCommand(entry.commandId, {
                nextAttemptAt: backoffAt(entry.attemptCount),
                errorJson: errorJson(error),
              });
              return { kind: "paused", reason: "invalid-response", receipts };
          }
        }
        if (error instanceof TeamApiError) {
          switch (error.code) {
            case "MEMBERSHIP_CHANGED":
              // Failed preconditions consume no command id (C6); requeue and
              // let the next sync quarantine and re-bootstrap.
              outbox.requeueCommand(entry.commandId, { nextAttemptAt: null, countAttempt: false });
              return { kind: "sync-required", reason: "membership-changed", receipts };
            case "SERVER_EPOCH_CHANGED":
              outbox.requeueCommand(entry.commandId, { nextAttemptAt: null, countAttempt: false });
              return { kind: "sync-required", reason: "server-epoch-changed", receipts };
            case "WORKSPACE_FORBIDDEN":
              cache.quarantine("workspace-forbidden");
              return { kind: "forbidden", receipts };
            case "SESSION_REVOKED":
              cache.quarantine("session-revoked");
              return { kind: "locked", reason: "session-revoked", receipts };
            case "UNAUTHENTICATED":
              outbox.requeueCommand(entry.commandId, { nextAttemptAt: null, countAttempt: false });
              return { kind: "locked", reason: "unauthenticated", receipts };
            default:
              break;
          }
          if (isRetryableApiError(error)) {
            outbox.requeueCommand(entry.commandId, {
              nextAttemptAt: backoffAt(entry.attemptCount, error.retryAfterMs),
              errorJson: errorJson(error),
            });
            return { kind: "retry-later", receipts };
          }
          // 409s are precondition conflicts a human must rebase; 422/403/quota
          // rejections can never succeed as submitted. Both are terminal.
          outbox.failCommand(entry.commandId, {
            state: CONFLICT_CODES.has(error.code) ? "conflict" : "rejected",
            errorJson: errorJson(error),
          });
          continue;
        }
        // Unknown failure: back off and stop rather than guessing.
        outbox.requeueCommand(entry.commandId, {
          nextAttemptAt: backoffAt(entry.attemptCount),
          errorJson: JSON.stringify({ reason: "unknown", message: "The command failed with an unexpected error." }),
        });
        return { kind: "offline", receipts };
      }

      // The receipt is recorded before the acknowledgement is persisted: a
      // crash in between replays the same command id server-side (C6).
      receipts.push(receipt);
      try {
        outbox.acknowledgeCommand(entry.commandId, JSON.stringify(receipt));
      } catch {
        return { kind: "paused", reason: "store-error", receipts };
      }
    }
  } finally {
    outbox.releaseDrainLease(options.holder);
  }
}
