import type { Pool } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { principalId } from "../auth/principal.js";
import { withTransaction } from "../db.js";
import { CATALOGUE_UNION, type CatalogRecord } from "./catalog-records.js";
import { CursorSigner } from "./cursors.js";
import { sweepExpiredSyncState } from "./retention.js";

/**
 * Materialized catalogue bootstrap (contract §C7). POST semantics: reuse a
 * still-valid snapshot for the same principal/workspace/generation/epoch
 * (200-equivalent `created: false`), otherwise replace the expired one and
 * materialize fresh (201-equivalent `created: true`). Rows are written with
 * INSERT ... SELECT inside a repeatable-read transaction that locks the
 * workspace and captures highWater from the same consistent state — the app
 * never buffers the catalogue in memory. Page tokens are signed and bound
 * to the snapshot; access is rechecked on every page.
 */

export const BOOTSTRAP_TTL_MS = 10 * 60_000;

export interface BootstrapStartInput {
  principal: Principal;
  workspaceId: string;
  membershipGeneration: string;
  serverEpoch: string;
  currentEpoch: string;
  currentGeneration: string;
}

export interface BootstrapStart {
  snapshotId: string;
  highWater: string;
  expiresAt: string;
  serverEpoch: string;
  membershipGeneration: string;
  created: boolean;
}

export async function startBootstrap(pool: Pool, input: BootstrapStartInput): Promise<BootstrapStart> {
  if (input.serverEpoch !== input.currentEpoch) {
    throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; bootstrap again with the current epoch");
  }
  if (input.membershipGeneration !== input.currentGeneration) {
    throw teamError("MEMBERSHIP_CHANGED", "Membership changed; refresh your generation");
  }
  const principalKey = principalId(input.principal);

  return withTransaction(pool, async (tx) => {
    // Workspace lock first: the sequence read below IS the highWater, taken
    // from the same repeatable-read snapshot the rows are materialized from.
    await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const locked = await tx.query<{ next_catalog_seq: string; id: string }>(
      "SELECT next_catalog_seq::text, id FROM team_workspaces WHERE id = $1 FOR UPDATE",
      [input.workspaceId],
    );
    const workspace = locked.rows[0];
    if (!workspace) throw teamError("NOT_FOUND", "Workspace not found");
    const highWater = String(Number(workspace.next_catalog_seq) - 1);

    const existing = await tx.query<{ snapshot_id: string; expires_at: Date }>(
      `SELECT snapshot_id, expires_at FROM team_bootstraps
        WHERE workspace_id = $1 AND principal_key = $2 AND membership_generation = $3 AND server_epoch = $4
        FOR UPDATE`,
      [input.workspaceId, principalKey, input.membershipGeneration, input.serverEpoch],
    );
    const prior = existing.rows[0];
    if (prior && prior.expires_at.getTime() > Date.now()) {
      return {
        snapshotId: prior.snapshot_id,
        highWater,
        expiresAt: prior.expires_at.toISOString(),
        serverEpoch: input.serverEpoch,
        membershipGeneration: input.membershipGeneration,
        created: false,
      };
    }

    const snapshotId = (await tx.query<{ snapshot_id: string }>(
      `INSERT INTO team_bootstraps (workspace_id, principal_key, principal_user_id, membership_generation, server_epoch, high_water, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
       RETURNING snapshot_id`,
      [
        input.workspaceId,
        principalKey,
        input.principal.kind === "human" ? input.principal.userId : null,
        input.membershipGeneration,
        input.serverEpoch,
        Number(highWater),
      ],
    )).rows[0]!.snapshot_id;
    if (prior) {
      await tx.query("DELETE FROM team_bootstrap_rows WHERE snapshot_id = $1", [prior.snapshot_id]);
      await tx.query("DELETE FROM team_bootstraps WHERE snapshot_id = $1", [prior.snapshot_id]);
    }

    await tx.query(
      `INSERT INTO team_bootstrap_rows (snapshot_id, ordinal, record_json)
       SELECT $1, ordinal, record FROM (${CATALOGUE_UNION.replace(/\$1\b/g, "$2")}) catalogue`,
      [snapshotId, input.workspaceId],
    );

    const expires = (await tx.query<{ expires_at: Date }>("SELECT expires_at FROM team_bootstraps WHERE snapshot_id = $1", [snapshotId])).rows[0]!;
    return {
      snapshotId,
      highWater,
      expiresAt: expires.expires_at.toISOString(),
      serverEpoch: input.serverEpoch,
      membershipGeneration: input.membershipGeneration,
      created: true,
    };
  });
}

export interface BootstrapPage {
  snapshotId: string;
  records: CatalogRecord[];
  nextPageToken: string | null;
  highWater: string;
  serverEpoch: string;
  membershipGeneration: string;
}

export async function readBootstrapPage(
  pool: Pool,
  input: {
    principal: Principal;
    workspaceId: string;
    snapshotId: string;
    pageToken?: string;
    signer: CursorSigner;
    currentEpoch: string;
    currentGeneration: string;
    limit?: number;
  },
): Promise<BootstrapPage> {
  let offset = 0;
  if (input.pageToken) {
    const claims = input.signer.verify<{ s: string; o: number }>(input.pageToken);
    if (!claims || claims.s !== input.snapshotId || !Number.isInteger(claims.o) || claims.o < 0) {
      throw teamError("VALIDATION_FAILED", "Invalid page token");
    }
    offset = claims.o;
  }
  const snapshot = await pool.query<{
    snapshot_id: string;
    principal_key: string;
    membership_generation: string;
    server_epoch: string;
    high_water: string;
    expires_at: Date;
  }>(
    "SELECT snapshot_id, principal_key, membership_generation, server_epoch, high_water::text AS high_water, expires_at FROM team_bootstraps WHERE snapshot_id = $1 AND workspace_id = $2",
    [input.snapshotId, input.workspaceId],
  );
  const row = snapshot.rows[0];
  if (!row || row.principal_key !== principalId(input.principal)) {
    throw teamError("SNAPSHOT_EXPIRED", "Snapshot not found for this principal; start a new bootstrap");
  }
  if (row.expires_at.getTime() <= Date.now()) {
    await sweepExpiredSyncState(pool).catch(() => undefined);
    throw teamError("SNAPSHOT_EXPIRED", "Snapshot expired; start a new bootstrap");
  }
  // Access is rechecked on EVERY page (contract §C7).
  if (row.server_epoch !== input.currentEpoch) {
    throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; bootstrap again");
  }
  if (row.membership_generation !== input.currentGeneration) {
    throw teamError("MEMBERSHIP_CHANGED", "Membership changed; refresh your generation");
  }

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const rows = await pool.query<{ record_json: CatalogRecord }>(
    "SELECT record_json FROM team_bootstrap_rows WHERE snapshot_id = $1 AND ordinal >= $2 ORDER BY ordinal LIMIT $3",
    [input.snapshotId, offset, limit],
  );
  const records = rows.rows.map((r) => r.record_json);
  const hasMore = rows.rows.length === limit;
  return {
    snapshotId: input.snapshotId,
    records,
    nextPageToken: hasMore ? input.signer.sign({ s: input.snapshotId, o: offset + limit }) : null,
    highWater: row.high_water,
    serverEpoch: row.server_epoch,
    membershipGeneration: row.membership_generation,
  };
}
