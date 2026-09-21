import { randomUUID } from "node:crypto";
import type { PoolClient } from "../db.js";
import type { Principal } from "../auth/principal.js";

/**
 * Append-only audit trail (contract §C6). Metadata only: no prompt content,
 * no tokens, no credentials — resource ids and coarse fields. Every mutating
 * command appends its audit row in the SAME transaction as the mutation.
 */

export interface AuditEntry {
  workspaceId: string;
  actor: Principal;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

export function appendAudit(tx: PoolClient, entry: AuditEntry): Promise<void> {
  return tx
    .query(
      `INSERT INTO team_audit (workspace_id, id, actor_user_id, actor_agent_token_id, action, resource_type, resource_id, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.workspaceId,
        randomUUID(),
        entry.actor.kind === "human" ? entry.actor.userId : null,
        entry.actor.kind === "agent" ? entry.actor.tokenId : null,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        JSON.stringify(entry.metadata ?? {}),
      ],
    )
    .then(() => undefined);
}

export interface AuditSummary {
  id: string;
  actorUserId: string | null;
  actorAgentTokenId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

/** Owner-facing audit page (contract §C4) — ids only, no content columns exist. */
export async function listAudit(
  pool: { query: PoolClient["query"] },
  workspaceId: string,
  options: { limit: number; before?: Date },
): Promise<AuditSummary[]> {
  const result = await pool.query<{
    id: string;
    actor_user_id: string | null;
    actor_agent_token_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    created_at: Date;
  }>(
    `SELECT id, actor_user_id, actor_agent_token_id, action, resource_type, resource_id, created_at
       FROM team_audit
      WHERE workspace_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC, id
      LIMIT $3`,
    [workspaceId, options.before ?? null, options.limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    actorAgentTokenId: row.actor_agent_token_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at.toISOString(),
  }));
}
