import pg from "pg";
import { withTransaction, type PoolClient } from "./db.js";
import { isRetryableSqlError, teamError } from "./errors.js";

export interface WorkspaceTransactionOptions {
  workspaceId: string;
  /**
   * Command identity for retries. Serialization/deadlock failures are re-run
   * with the SAME command ID — the command handler re-resolves its receipt
   * inside the retried transaction, which keeps the mutation idempotent
   * (contract C6). Never retry with a fresh command ID.
   */
  commandId?: string;
}

export interface WorkspaceRow {
  id: string;
  entity_version: number;
  next_catalog_seq: string;
  server_epoch: string;
}

export interface WorkspaceTx {
  tx: PoolClient;
  workspaceId: string;
  workspace: WorkspaceRow;
}

/** Maximum re-runs of a serialization/deadlock failure, per contract C6. */
export const MAX_WORKSPACE_TX_ATTEMPTS = 3;

/**
 * Every workspace mutation runs through this helper. Lock order (contract C6):
 * the workspace row is locked FIRST (`FOR UPDATE` — it doubles as the
 * serialization lock), then membership and target rows inside the operation.
 * Whichever transaction acquires the workspace lock first defines the
 * before/after authorization for role changes and removals.
 *
 * Validation/authorization failures roll back and propagate; serialization
 * (40001) and deadlock (40P01) failures re-run the operation on the same
 * command identity up to `MAX_WORKSPACE_TX_ATTEMPTS` attempts.
 */
export async function withWorkspaceTransaction<T>(
  pool: pg.Pool,
  options: WorkspaceTransactionOptions,
  fn: (work: WorkspaceTx) => Promise<T>,
): Promise<T> {
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= MAX_WORKSPACE_TX_ATTEMPTS; attempt++) {
    try {
      return await withTransaction(pool, async (tx) => {
        const locked = await tx.query<WorkspaceRow>(
          "SELECT id, entity_version, next_catalog_seq, server_epoch FROM team_workspaces WHERE id = $1 FOR UPDATE",
          [options.workspaceId],
        );
        const workspace = locked.rows[0];
        // Unknown workspace ids and purged workspaces are indistinguishable by
        // design: no data leaks from existence checks (contract C2).
        if (!workspace || workspace.server_epoch === null) {
          throw teamError("NOT_FOUND", "Workspace not found");
        }
        return fn({ tx, workspaceId: options.workspaceId, workspace });
      });
    } catch (error) {
      if (isRetryableSqlError(error)) {
        lastConflict = error;
        continue;
      }
      throw error;
    }
  }
  throw teamError("UNAVAILABLE", "Workspace transaction kept conflicting; try again", {
    details: { attempts: MAX_WORKSPACE_TX_ATTEMPTS, sqlState: (lastConflict as { code: string }).code },
  });
}
