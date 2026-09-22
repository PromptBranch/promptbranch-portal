import { randomUUID } from "node:crypto";
import type { Pool } from "../db.js";
import { withTransaction } from "../db.js";

/**
 * Backup-restore recovery (plan P9). Restore starts with
 * `TEAM_RECOVERY_MODE=1`: the portal refuses all ordinary team traffic
 * (every route 503s — no service is registered) while the operator runs
 * `enterRecovery` against the restored database, then reconciles membership
 * against a verified current roster with `finishRecoveryWithRoster`, and
 * only then clears the env flag. A stale backup must never silently revive
 * removed members or honor pre-restore sessions — epoch rotation, blanket
 * session/token revocation and cursor invalidation guarantee that even if a
 * step is skipped. Every window is recorded in team_recovery_log.
 */

export interface RecoveryWindow {
  recoveryId: string;
  rotatedEpochs: number;
  revokedAppSessions: number;
  revokedAgentTokens: number;
  cancelledJobs: number;
}

export async function enterRecovery(pool: Pool, input: { restoredFrom: string; note?: string }): Promise<RecoveryWindow> {
  return withTransaction(pool, async (tx) => {
    // New server epoch everywhere: every cached client must re-bootstrap.
    const rotated = await tx.query<{ count: string }>(
      `UPDATE team_workspaces
          SET server_epoch = gen_random_uuid(), entity_version = entity_version + 1, updated_at = now()
        WHERE deleted_at IS NULL
        RETURNING 1`,
    );

    // Blanket revocation: pre-restore tokens, sessions and queued work die.
    const sessions = await tx.query("UPDATE team_sessions SET revoked_at = now() WHERE revoked_at IS NULL");
    const tokens = await tx.query("UPDATE team_agent_tokens SET revoked_at = now() WHERE revoked_at IS NULL");
    const jobs = await tx.query("UPDATE team_jobs SET status = 'cancelled', updated_at = now() WHERE status IN ('pending', 'running')");

    // Materialized sync state and feed cursors are from the old world.
    await tx.query("DELETE FROM team_bootstraps");
    await tx.query(
      `UPDATE team_workspaces
          SET min_retained_seq = next_catalog_seq
        WHERE deleted_at IS NULL AND min_retained_seq < next_catalog_seq`,
    );

    const recoveryId = randomUUID();
    await tx.query(
      "INSERT INTO team_recovery_log (id, restored_from, note) VALUES ($1, $2, $3)",
      [recoveryId, input.restoredFrom, input.note ?? ""],
    );
    return {
      recoveryId,
      rotatedEpochs: rotated.rows.length,
      revokedAppSessions: sessions.rowCount ?? 0,
      revokedAgentTokens: tokens.rowCount ?? 0,
      cancelledJobs: jobs.rowCount ?? 0,
    };
  });
}

export interface RosterReconciliation {
  recoveryId: string;
  keptMemberships: number;
  removedMemberships: number;
  lastOwnerProtections: number;
}

/**
 * Closes the newest open recovery window after the operator verified the
 * roster: every membership whose (enabled) member is NOT on the roster is
 * removed. Sole-owner workspaces are never left ownerless — the removal is
 * skipped and counted instead, forcing the operator to resolve those by
 * hand (add a rostered owner first). With that done, clearing
 * TEAM_RECOVERY_MODE resumes ordinary traffic at the rotated epoch.
 */
export async function finishRecoveryWithRoster(
  pool: Pool,
  input: { rosterEmails: string[]; note?: string },
): Promise<RosterReconciliation> {
  const open = await pool.query<{ id: string }>(
    "SELECT id FROM team_recovery_log WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
  );
  const recoveryId = open.rows[0]?.id;
  if (!recoveryId) throw new Error("no open recovery window to finish");

  return withTransaction(pool, async (tx) => {
    const roster = input.rosterEmails.map((email) => email.trim().toLowerCase()).filter(Boolean);

    // Memberships to keep: rostered, still-enabled users.
    const keep = await tx.query<{ workspace_id: string; user_id: string }>(
      `SELECT m.workspace_id, m.user_id
         FROM team_memberships m
         JOIN team_users u ON u.id = m.user_id
        WHERE m.removed_at IS NULL
          AND u.disabled_at IS NULL AND u.deleted_at IS NULL
          AND lower(u.verified_email) = ANY($1::text[])`,
      [roster],
    );

    // Candidates for removal: active memberships of users NOT on the roster
    // (or disabled by the backup's own state).
    const candidates = await tx.query<{ workspace_id: string; user_id: string; role: string }>(
      `SELECT m.workspace_id, m.user_id, m.role
         FROM team_memberships m
         JOIN team_users u ON u.id = m.user_id
        WHERE m.removed_at IS NULL
          AND (u.disabled_at IS NOT NULL OR u.deleted_at IS NOT NULL
               OR lower(u.verified_email) <> ALL($1::text[]))`,
      [roster],
    );

    let removed = 0;
    let protectedOwners = 0;
    const candidateByWorkspace = new Map<string, { userId: string; role: string }[]>();
    for (const row of candidates.rows) {
      const list = candidateByWorkspace.get(row.workspace_id) ?? [];
      list.push({ userId: row.user_id, role: row.role });
      candidateByWorkspace.set(row.workspace_id, list);
    }
    for (const [workspaceId, list] of candidateByWorkspace) {
      const keptOwners = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM team_memberships
          WHERE workspace_id = $1 AND removed_at IS NULL AND role = 'owner'
            AND user_id <> ALL($2::uuid[])`,
        [workspaceId, list.filter((c) => c.role === "owner").map((c) => c.userId)],
      );
      const remainingOwners = Number(keptOwners.rows[0]!.count);
      const removingOwners = list.filter((c) => c.role === "owner").length;
      if (remainingOwners - removingOwners < 1) {
        protectedOwners += 1;
        continue;
      }
      await tx.query(
        "UPDATE team_memberships SET removed_at = now(), generation = gen_random_uuid(), updated_at = now() WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])",
        [workspaceId, list.map((c) => c.userId)],
      );
      removed += list.length;
    }

    await tx.query("UPDATE team_recovery_log SET finished_at = now(), note = note || $2 WHERE id = $1", [
      recoveryId,
      ` | reconciled: kept=${keep.rows.length} removed=${removed} protected=${protectedOwners}${input.note ? ` | ${input.note}` : ""}`,
    ]);
    return { recoveryId, keptMemberships: keep.rows.length, removedMemberships: removed, lastOwnerProtections: protectedOwners };
  });
}
