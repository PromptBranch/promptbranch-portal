import type { Pool, PoolClient } from "../db.js";
import type { SecretBox } from "../auth/crypto.js";

/**
 * Transactional job outbox (contract §C6/C8). Invitation email (and later
 * lifecycle work) is enqueued in the mutation's own transaction — never
 * send-before-commit. Payloads are AES-256-GCM encrypted; the invitation
 * secret exists in the payload only until delivery succeeds, then it is
 * cleared. Workers claim jobs with FOR UPDATE SKIP LOCKED so concurrent
 * workers never double-send.
 */

export type TeamJobType = "invitation.email" | "workspace.purge" | "audit.purge" | "bootstrap.expire" | "changes.expire" | "maintenance";

export interface ClaimedJob {
  id: string;
  workspaceId: string | null;
  type: TeamJobType;
  attempts: number;
  payload: unknown;
}

/** Retry ladder for transient delivery failures (contract §P9: 1m, 5m, 30m, 2h). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

const JOB_LEASE_MS = 5 * 60_000;

export async function enqueueJob(
  tx: PoolClient | Pool,
  input: { workspaceId: string | null; type: TeamJobType; payload: Record<string, unknown>; secretBox: SecretBox },
): Promise<string> {
  const sealed = input.secretBox.seal(JSON.stringify(input.payload));
  const id = (await tx.query<{ id: string }>(
    `INSERT INTO team_jobs (workspace_id, type, payload_encrypted, payload_nonce, payload_key_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.workspaceId, input.type, sealed.ciphertext, sealed.nonce, sealed.keyId],
  )).rows[0]!.id;
  return id;
}

/** Claims up to `limit` due jobs; sets status running with a lease. */
export async function claimDueJobs(
  pool: Pool,
  options: { limit: number; secretBox: SecretBox },
): Promise<ClaimedJob[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query<{
      id: string;
      workspace_id: string | null;
      type: TeamJobType;
      attempts: number;
      payload_encrypted: Buffer;
      payload_nonce: Buffer;
      payload_key_id: string;
    }>(
      `SELECT id, workspace_id, type, attempts, payload_encrypted, payload_nonce, payload_key_id
         FROM team_jobs
        WHERE status = 'pending' AND run_after <= now()
        ORDER BY run_after, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [options.limit],
    )).rows;
    for (const row of rows) {
      await client.query("UPDATE team_jobs SET status = 'running', locked_until = now() + $2::interval, updated_at = now() WHERE id = $1", [
        row.id,
        `${JOB_LEASE_MS / 1000} seconds`,
      ]);
    }
    await client.query("COMMIT");
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      attempts: row.attempts,
      payload:
        row.payload_encrypted.length > 0
          ? JSON.parse(options.secretBox.open({ ciphertext: row.payload_encrypted, nonce: row.payload_nonce, keyId: row.payload_key_id }).toString("utf8"))
          : null,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Marks success; invitation secrets leave the payload on first delivery. */
export async function completeJob(pool: Pool, jobId: string, options: { clearPayload: boolean }): Promise<void> {
  await pool.query(
    `UPDATE team_jobs
        SET status = 'done', attempts = attempts + 1, locked_until = NULL,
            payload_encrypted = CASE WHEN $2 THEN NULL ELSE payload_encrypted END,
            payload_nonce = CASE WHEN $2 THEN NULL ELSE payload_nonce END,
            payload_key_id = CASE WHEN $2 THEN NULL ELSE payload_key_id END,
            updated_at = now()
      WHERE id = $1`,
    [jobId, options.clearPayload],
  );
}

/** Records a failure; reschedules along the ladder or fails terminally. */
export async function failJob(pool: Pool, jobId: string, errorCode: string): Promise<void> {
  const row = (await pool.query<{ attempts: number }>(
    "UPDATE team_jobs SET attempts = attempts + 1, updated_at = now() WHERE id = $1 RETURNING attempts",
    [jobId],
  )).rows[0];
  if (!row) return;
  const delay = RETRY_DELAYS_MS[Math.min(row.attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  if (row.attempts > RETRY_DELAYS_MS.length) {
    await pool.query("UPDATE team_jobs SET status = 'failed', last_error_code = $2, locked_until = NULL, updated_at = now() WHERE id = $1", [jobId, errorCode]);
    return;
  }
  await pool.query(
    "UPDATE team_jobs SET status = 'pending', run_after = now() + $2::interval, last_error_code = $3, locked_until = NULL, updated_at = now() WHERE id = $1",
    [jobId, `${Math.ceil(delay / 1000)} seconds`, errorCode],
  );
}
