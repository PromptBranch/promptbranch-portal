import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { appendAudit } from "./audit.js";

/**
 * Workspace organization (contract §C3/C4): tags and collections with
 * trimmed case-insensitive unique names per workspace, display case
 * preserved. Deletes cascade over junction rows transactionally.
 */

const TABLE = { tag: "team_tags", collection: "team_collections" } as const;
export type OrgEntity = keyof typeof TABLE;

const LIMITS = { tag: 50, collection: 100 } as const;

interface OrgRow {
  id: string;
  name: string;
  entity_version: number;
}

async function normalize(name: string, entity: OrgEntity): Promise<string> {
  const trimmed = name.trim();
  const max = LIMITS[entity];
  if (trimmed.length < 1 || trimmed.length > max) {
    throw teamError("VALIDATION_FAILED", `${entity} name must be 1-${max} characters after trimming`);
  }
  return trimmed.toLowerCase();
}

export async function createOrgEntity(
  tx: PoolClient,
  input: { entity: OrgEntity; workspaceId: string; actor: Principal; name: string },
): Promise<{ id: string; entityVersion: number }> {
  const displayName = input.name.trim();
  const normalized = await normalize(input.name, input.entity);
  const id = randomUUID();
  const inserted = await tx.query<{ entity_version: number }>(
    `INSERT INTO ${TABLE[input.entity]} (workspace_id, id, name, normalized_name)
     VALUES ($1, $2, $3, $4) RETURNING entity_version`,
    [input.workspaceId, id, displayName, normalized],
  ).catch((error: { code?: string }) => {
    // Unique index on (workspace, normalized_name): a differing-case twin
    // collides exactly like an exact duplicate.
    if (error.code === "23505") {
      throw teamError("VALIDATION_FAILED", `A ${input.entity} with that name already exists in this workspace`);
    }
    throw error;
  });
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `${input.entity}.create`,
    resourceType: input.entity,
    resourceId: id,
  });
  return { id, entityVersion: inserted.rows[0]!.entity_version };
}

export async function renameOrgEntity(
  tx: PoolClient,
  input: { entity: OrgEntity; workspaceId: string; actor: Principal; id: string; name: string; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  await normalize(input.name, input.entity);
  const updated = await tx
    .query<{ entity_version: number }>(
      `UPDATE ${TABLE[input.entity]}
         SET name = $3, normalized_name = $4, entity_version = entity_version + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND entity_version = $5
        RETURNING entity_version`,
      [input.workspaceId, input.id, input.name.trim(), input.name.trim().toLowerCase(), input.expectedEntityVersion],
    )
    .catch((error: { code?: string }) => {
      if (error.code === "23505") {
        throw teamError("VALIDATION_FAILED", `A ${input.entity} with that name already exists in this workspace`);
      }
      throw error;
    });
  if (!updated.rows[0]) {
    const existing = await tx.query<{ entity_version: number }>(
      `SELECT entity_version FROM ${TABLE[input.entity]} WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, input.id],
    );
    if (!existing.rows[0]) throw teamError("NOT_FOUND", `${input.entity} not found`);
    throw teamError("STALE_ENTITY", `${input.entity} changed; refresh and retry`);
  }
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `${input.entity}.rename`,
    resourceType: input.entity,
    resourceId: input.id,
  });
  return { entityVersion: updated.rows[0].entity_version };
}

/** Delete removes every prompt reference in the same transaction. */
export async function deleteOrgEntity(
  tx: PoolClient,
  input: { entity: OrgEntity; workspaceId: string; actor: Principal; id: string; expectedEntityVersion: number },
): Promise<void> {
  // Version-checked claim first; junction rows are removed BEFORE the entity
  // row or the composite FK would refuse the delete.
  const claimed = await tx.query(
    `UPDATE ${TABLE[input.entity]} SET entity_version = entity_version WHERE workspace_id = $1 AND id = $2 AND entity_version = $3`,
    [input.workspaceId, input.id, input.expectedEntityVersion],
  );
  if ((claimed.rowCount ?? 0) === 0) {
    const existing = await tx.query<{ entity_version: number }>(
      `SELECT entity_version FROM ${TABLE[input.entity]} WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, input.id],
    );
    if (!existing.rows[0]) throw teamError("NOT_FOUND", `${input.entity} not found`);
    throw teamError("STALE_ENTITY", `${input.entity} changed; refresh and retry`);
  }
  const junction =
    input.entity === "tag"
      ? "DELETE FROM team_prompt_tags WHERE workspace_id = $1 AND tag_id = $2"
      : "DELETE FROM team_collection_prompts WHERE workspace_id = $1 AND collection_id = $2";
  await tx.query(junction, [input.workspaceId, input.id]);
  await tx.query(`DELETE FROM ${TABLE[input.entity]} WHERE workspace_id = $1 AND id = $2`, [input.workspaceId, input.id]);
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `${input.entity}.delete`,
    resourceType: input.entity,
    resourceId: input.id,
  });
}

export async function listOrgEntities(
  pool: Pool,
  entity: OrgEntity,
  workspaceId: string,
): Promise<Array<{ id: string; workspaceId: string; name: string; entityVersion: number }>> {
  const result = await pool.query<OrgRow>(
    `SELECT id, name, entity_version FROM ${TABLE[entity]} WHERE workspace_id = $1 ORDER BY normalized_name, id LIMIT 200`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId,
    name: row.name,
    entityVersion: row.entity_version,
  }));
}
