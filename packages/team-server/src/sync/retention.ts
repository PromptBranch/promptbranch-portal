import type { Pool } from "../db.js";

/**
 * Retention sweep (contract §C7): bootstrap rows live 10 minutes, change
 * events 30 days, rate buckets until their window expires. The minimum
 * retained cursor advances ONLY after the rows are deleted, in the same
 * transaction — pruning can never create an apparent gap between the floor
 * and surviving events.
 */

export interface SweepResult {
  expiredBootstraps: number;
  prunedChanges: number;
  expiredRateBuckets: number;
  expiredExports: number;
}

const MAX_CHANGES_PER_SWEEP = 5_000;

export async function sweepExpiredSyncState(pool: Pool): Promise<SweepResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bootstraps = await client.query("DELETE FROM team_bootstraps WHERE expires_at <= now()");
    const buckets = await client.query("DELETE FROM team_rate_buckets WHERE expires_at <= now()");
    // Export rows cascade with their snapshot.
    const exports = await client.query("DELETE FROM team_exports WHERE expires_at <= now()");

    const deleted = await client.query<{ workspace_id: string; seq: string }>(
      `DELETE FROM team_changes
        WHERE ctid IN (
          SELECT ctid FROM team_changes
           WHERE created_at < now() - interval '30 days'
           ORDER BY seq
           LIMIT $1
        )
        RETURNING workspace_id, seq::text AS seq`,
      [MAX_CHANGES_PER_SWEEP],
    );
    // The floor is the minimum cursor still servable: a client sitting AT
    // the newest deleted sequence lost nothing (everything after it
    // survives), so the floor equals that sequence, advanced monotonically.
    if (deleted.rows.length > 0) {
      const highest = new Map<string, number>();
      for (const row of deleted.rows) {
        const seq = Number(row.seq);
        highest.set(row.workspace_id, Math.max(highest.get(row.workspace_id) ?? 0, seq));
      }
      for (const [workspaceId, seq] of highest) {
        await client.query(
          `UPDATE team_workspaces
              SET min_retained_seq = GREATEST(min_retained_seq, $2)
            WHERE id = $1`,
          [workspaceId, seq],
        );
      }
    }

    await client.query("COMMIT");
    return {
      expiredBootstraps: bootstraps.rowCount ?? 0,
      prunedChanges: deleted.rowCount ?? 0,
      expiredRateBuckets: buckets.rowCount ?? 0,
      expiredExports: exports.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
