import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import { buildRecord, type CatalogRecord, type CatalogTombstone } from "./catalog-records.js";

/**
 * Per-workspace change feed (contract §C7). Sequences are allocated from
 * team_workspaces.next_catalog_seq WHILE HOLDING the workspace row lock —
 * the same lock every mutation takes — so sequence order and commit order
 * can never disagree. A Change groups the entire logical mutation.
 */

export interface Change {
  seq: string;
  records: CatalogRecord[];
  tombstones: CatalogTombstone[];
}

export interface AppendChangeInput {
  workspaceId: string;
  records: Array<{ kind: "prompt" | "revision" | "tag" | "collection"; id: string }>;
  tombstones?: CatalogTombstone[];
}

/**
 * Appends one change event inside the caller's locked workspace transaction
 * and returns the allocated sequence. Only catalogue-affecting commands call
 * this; comments/membership mutations emit nothing.
 */
export async function appendCatalogChange(tx: PoolClient, input: AppendChangeInput): Promise<string> {
  const records: CatalogRecord[] = [];
  for (const spec of input.records) {
    const record = await buildRecord(tx, spec.kind, input.workspaceId, spec.id);
    if (record) records.push(record);
  }
  if (records.length === 0 && (input.tombstones ?? []).length === 0) {
    throw teamError("UNAVAILABLE", "Refusing to emit an empty catalogue event");
  }
  const allocated = await tx.query<{ seq: string }>(
    `UPDATE team_workspaces SET next_catalog_seq = next_catalog_seq + 1, updated_at = now()
      WHERE id = $1 RETURNING (next_catalog_seq - 1)::text AS seq`,
    [input.workspaceId],
  );
  const seq = allocated.rows[0]!.seq;
  await tx.query(
    "INSERT INTO team_changes (workspace_id, seq, payload_json) VALUES ($1, $2, $3)",
    [input.workspaceId, seq, JSON.stringify({ records, tombstones: input.tombstones ?? [] })],
  );
  return seq;
}

export interface ChangesPage {
  changes: Change[];
  nextCursor: string;
  hasMore: boolean;
}

/** Serialized page ceiling (contract §C2: 512 KiB, one entity never split). */
const MAX_PAGE_BYTES = 512 * 1024;

export async function readChanges(
  pool: Pool,
  input: { workspaceId: string; after: string; limit?: number; minRetainedSeq: number; currentMaxSeq: number },
): Promise<ChangesPage> {
  if (!/^\d+$/.test(input.after) || input.after.length > 20) {
    throw teamError("VALIDATION_FAILED", "after must be a decimal sequence string");
  }
  const after = BigInt(input.after);
  if (after < 0n) throw teamError("VALIDATION_FAILED", "after must be non-negative");
  if (after < BigInt(input.minRetainedSeq)) {
    throw teamError("CURSOR_EXPIRED", "Feed retention no longer covers this cursor; bootstrap again");
  }
  if (after > BigInt(input.currentMaxSeq)) {
    throw teamError("VALIDATION_FAILED", "after points past the newest sequence");
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const result = await pool.query<{ seq: string; payload_json: { records: CatalogRecord[]; tombstones: CatalogTombstone[] } }>(
    `SELECT seq::text AS seq, payload_json FROM team_changes
      WHERE workspace_id = $1 AND seq > $2
      ORDER BY seq
      LIMIT $3`,
    [input.workspaceId, input.after, limit],
  );
  // Stop before overflowing the page budget; a single record is never split.
  const changes: Change[] = [];
  let bytes = 0;
  for (const row of result.rows) {
    const size = JSON.stringify(row.payload_json).length;
    if (changes.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
    changes.push({ seq: row.seq, records: row.payload_json.records, tombstones: row.payload_json.tombstones });
    bytes += size;
  }
  const lastSeq = changes.at(-1)?.seq ?? input.after;
  const hasMore = result.rows.length === limit && changes.length === result.rows.length;
  return { changes, nextCursor: lastSeq, hasMore };
}

/** Current feed bounds for cursor validation. */
export async function feedBounds(pool: Pool, workspaceId: string): Promise<{ minRetainedSeq: number; currentMaxSeq: number }> {
  const result = await pool.query<{ min_retained_seq: string; next_catalog_seq: string }>(
    "SELECT min_retained_seq::text, next_catalog_seq::text FROM team_workspaces WHERE id = $1",
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw teamError("NOT_FOUND", "Workspace not found");
  return {
    minRetainedSeq: Number(row.min_retained_seq),
    // Sequences are pre-allocated; the newest committed one is next-1. A
    // concurrent in-flight allocation may exceed it, which readChanges
    // tolerates because `after` at the current max simply returns what has
    // committed when the query runs.
    currentMaxSeq: Number(row.next_catalog_seq) - 1,
  };
}
