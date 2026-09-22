import type { Pool } from "../db.js";

/**
 * Operator metrics (plan P9): numeric counters and gauges only — prompt
 * bodies and identities can never enter metrics by construction. The
 * process-local registry serves the health endpoint; the worker logs queue
 * gauges each tick. Time-series storage/alerting rides on the operator's
 * log pipeline (thresholds documented in deploy/team/README.md).
 */

const counters = new Map<string, number>();

export function incrementCounter(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export interface QueueGauges {
  pending: number;
  running: number;
  failed: number;
  /** Age in ms of the oldest due-but-unclaimed job (queue lag); 0 if none. */
  oldestDueMs: number;
}

export async function queueGauges(pool: Pool): Promise<QueueGauges> {
  const result = await pool.query<{ pending: string; running: string; failed: string; oldest_due: Date | null }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
            count(*) FILTER (WHERE status = 'running')::text AS running,
            count(*) FILTER (WHERE status = 'failed')::text AS failed,
            min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now()) AS oldest_due
       FROM team_jobs`,
  );
  const row = result.rows[0]!;
  return {
    pending: Number(row.pending),
    running: Number(row.running),
    failed: Number(row.failed),
    oldestDueMs: row.oldest_due ? Math.max(0, Date.now() - row.oldest_due.getTime()) : 0,
  };
}
