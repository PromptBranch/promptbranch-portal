import type { Pool } from "../db.js";

/**
 * Deletion lifecycle (plan P9): a deleted workspace's content purges 30
 * days after soft delete; audit rows live 90 days; the workspace tombstone
 * row stays until ALL of its audit has aged out, so audit FKs never dangle.
 * Purges are due-scans (like the retention sweep), not enqueued jobs — the
 * same guarantees with simpler restart semantics: every step is idempotent
 * and re-running after a crash re-selects the same due rows.
 */

export interface PurgeResult {
  purgedWorkspaces: number;
  purgedAuditRows: number;
  reclaimedTombstones: number;
}

/** Workspace-owned content tables in child-before-parent FK order. */
const PURGE_TABLES = [
  "team_comments",
  "team_reviews",
  "team_proposals",
  "team_publications",
  "team_prompt_search",
  "team_activity_items",
  "team_prompt_tags",
  "team_collection_prompts",
  "team_revisions",
  "team_prompts",
  "team_tags",
  "team_collections",
  // team_bootstrap_rows cascades from team_bootstraps (no workspace column).
  "team_bootstraps",
  "team_changes",
  "team_command_receipts",
  "team_jobs",
  "team_invitations",
  "team_agent_tokens",
  "team_memberships",
] as const;

export async function runPurgeSweep(pool: Pool): Promise<PurgeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Content purge: every workspace past its 30-day grace window. Prompt
    // heads are nullable exactly for this — clear them so revisions can go.
    const due = await client.query<{ id: string }>(
      "SELECT id FROM team_workspaces WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= now() ORDER BY purge_after LIMIT 100 FOR UPDATE SKIP LOCKED",
    );
    for (const workspace of due.rows) {
      await client.query("UPDATE team_prompts SET approved_revision_id = NULL WHERE workspace_id = $1 AND approved_revision_id IS NOT NULL", [workspace.id]);
      for (const table of PURGE_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspace.id]);
      }
      // Keep the tombstone: purge_after is cleared so the row is never
      // re-selected; reclamation waits for audit retention below.
      await client.query("UPDATE team_workspaces SET purge_after = NULL WHERE id = $1", [workspace.id]);
    }

    // Audit retention: metadata-only rows live 90 days, then go. The
    // append-only trigger blocks UPDATE, not DELETE.
    const audit = await client.query("DELETE FROM team_audit WHERE created_at < now() - interval '90 days'");

    // Tombstone reclamation: only once every audit row of the workspace is
    // gone (the audit FK enforces this anyway — the NOT EXISTS is clarity).
    const tombstones = await client.query(
      `DELETE FROM team_workspaces w
        WHERE w.deleted_at IS NOT NULL
          AND w.deleted_at < now() - interval '90 days'
          AND w.purge_after IS NULL
          AND NOT EXISTS (SELECT 1 FROM team_audit a WHERE a.workspace_id = w.id)`,
    );

    await client.query("COMMIT");
    return {
      purgedWorkspaces: due.rows.length,
      purgedAuditRows: audit.rowCount ?? 0,
      reclaimedTombstones: tombstones.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
