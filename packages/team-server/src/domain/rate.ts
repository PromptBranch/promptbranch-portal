import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";

/**
 * Shared rate buckets (contract C8): fixed-window counters in Postgres so
 * every app instance enforces the same quota for authenticated team
 * traffic. Anonymous snapshot limits stay in the portal's separate store.
 * The UPSERT is atomic, so concurrent callers can never read-modify-write
 * past the limit; a transaction that rolls back releases its increment.
 */

/** Wire-level quotas from contract C8 — required, immutable in protocol v1. */
export const WRITES_PER_MINUTE = 60;
export const INVITATIONS_PER_HOUR = 20;

export async function consumeRateBucket(
  client: Pool | PoolClient,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  // Stale windows for this key go first; the PK prefix keeps it a single-key
  // scan. Keys abandoned entirely are swept by the retention job.
  await client.query("DELETE FROM team_rate_buckets WHERE bucket_key = $1 AND expires_at <= now()", [key]);
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const { rows } = await client.query<{ count: number }>(
    `INSERT INTO team_rate_buckets (bucket_key, window_start, count, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_key, window_start)
     DO UPDATE SET count = team_rate_buckets.count + 1
     RETURNING count`,
    [key, windowStart, new Date(windowStart.getTime() + windowMs)],
  );
  if ((rows[0]?.count ?? 1) > limit) {
    throw teamError(
      "RATE_LIMITED",
      `Rate limit exceeded (${limit} per ${Math.round(windowMs / 1000)} seconds); retry after the current window`,
    );
  }
}
