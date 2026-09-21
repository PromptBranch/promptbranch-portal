import type { PoolClient } from "../db.js";

/**
 * CatalogRecord builders (contract §C3) as parameterized SQL. Every record
 * shape is built by the database in the mutation's own transaction, so the
 * feed never serializes stale or cross-transaction state and the bootstrap
 * INSERT ... SELECT stays memory-bounded.
 */

export type CatalogRecord =
  | { entity: "prompt"; value: Record<string, unknown> }
  | { entity: "revision"; value: Record<string, unknown> }
  | { entity: "tag"; value: Record<string, unknown> }
  | { entity: "collection"; value: Record<string, unknown> };

export interface CatalogTombstone {
  entity: "prompt" | "tag" | "collection";
  id: string;
}

/** RFC3339 UTC with microsecond precision, straight from timestamptz. */
const ISO = (column: string) =>
  `to_char(${column} AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const PROMPT_RECORD = (workspaceParam: number, idParam: number) => `
  SELECT jsonb_build_object('entity', 'prompt', 'value', jsonb_build_object(
    'id', p.id,
    'workspaceId', p.workspace_id,
    'title', p.title,
    'description', p.description,
    'approvedRevisionId', p.approved_revision_id,
    'tagIds', COALESCE((SELECT jsonb_agg(t.tag_id ORDER BY t.tag_id) FROM team_prompt_tags t
                         WHERE t.workspace_id = p.workspace_id AND t.prompt_id = p.id), '[]'::jsonb),
    'collectionIds', COALESCE((SELECT jsonb_agg(c.collection_id ORDER BY c.collection_id) FROM team_collection_prompts c
                         WHERE c.workspace_id = p.workspace_id AND c.prompt_id = p.id), '[]'::jsonb),
    'entityVersion', p.entity_version,
    'archivedAt', CASE WHEN p.archived_at IS NULL THEN NULL ELSE ${ISO("p.archived_at")} END,
    'createdAt', ${ISO("p.created_at")},
    'updatedAt', ${ISO("p.updated_at")}
  ))
  FROM team_prompts p
  WHERE p.workspace_id = $${workspaceParam} AND p.id = $${idParam}`;

/** Wrap a builder body so its single result column is named `record`. */
const AS_RECORD = (body: string) => `SELECT (${body.trim()}) AS record`;

const REVISION_RECORD = (workspaceParam: number, idParam: number) => `
  SELECT jsonb_build_object('entity', 'revision', 'value', jsonb_build_object(
    'id', r.id,
    'workspaceId', r.workspace_id,
    'promptId', r.prompt_id,
    'parentRevisionId', r.parent_revision_id,
    'content', r.content,
    'contentFormat', 'markdown',
    'contentHash', r.content_hash,
    'changeNote', r.change_note,
    'author', jsonb_build_object(
      'userId', COALESCE(r.author_user_id::text, ''),
      'displayName', CASE WHEN r.author_user_id IS NOT NULL THEN COALESCE(u.display_name, 'Former member') ELSE 'Agent' END,
      'agentTokenId', r.author_agent_id
    ),
    'createdAt', ${ISO("r.created_at")}
  ))
  FROM team_revisions r
  LEFT JOIN team_users u ON u.id = r.author_user_id
  WHERE r.workspace_id = $${workspaceParam} AND r.id = $${idParam}`;

const ORG_RECORD = (table: "team_tags" | "team_collections", entity: "tag" | "collection", workspaceParam: number, idParam: number) => `
  SELECT jsonb_build_object('entity', '${entity}', 'value', jsonb_build_object(
    'id', x.id,
    'workspaceId', x.workspace_id,
    'name', x.name,
    'entityVersion', x.entity_version
  ))
  FROM ${table} x
  WHERE x.workspace_id = $${workspaceParam} AND x.id = $${idParam}`;

/** Fetches one record; returns null when the row is missing. */
export async function buildRecord(
  tx: PoolClient,
  kind: "prompt" | "revision" | "tag" | "collection",
  workspaceId: string,
  id: string,
): Promise<CatalogRecord | null> {
  const body =
    kind === "prompt"
      ? PROMPT_RECORD(1, 2)
      : kind === "revision"
        ? REVISION_RECORD(1, 2)
        : ORG_RECORD(kind === "tag" ? "team_tags" : "team_collections", kind, 1, 2);
  // Scalar-subquery form names the column `record` and yields NULL rows
  // (not zero rows) when the target is missing — either way `.record` is
  // undefined and the caller treats it as absent.
  const result = await tx.query<{ record: CatalogRecord | null }>(AS_RECORD(body), [workspaceId, id]);
  return result.rows[0]?.record ?? null;
}

/** The full catalogue projection used by both the feed and the bootstrap:
 *  every prompt, every PUBLISHED revision, all tags and collections, in a
 *  deterministic order. Candidates are structurally absent (publications
 *  join). $1 binds the workspace id.
 */
export const CATALOGUE_UNION = `
  SELECT row_number() OVER (ORDER BY kind, id) - 1 AS ordinal, record FROM (
    SELECT 'a-prompt' AS kind, p.id AS id, jsonb_build_object('entity', 'prompt', 'value', jsonb_build_object(
        'id', p.id, 'workspaceId', p.workspace_id, 'title', p.title, 'description', p.description,
        'approvedRevisionId', p.approved_revision_id,
        'tagIds', COALESCE((SELECT jsonb_agg(t.tag_id ORDER BY t.tag_id) FROM team_prompt_tags t
                             WHERE t.workspace_id = p.workspace_id AND t.prompt_id = p.id), '[]'::jsonb),
        'collectionIds', COALESCE((SELECT jsonb_agg(c.collection_id ORDER BY c.collection_id) FROM team_collection_prompts c
                             WHERE c.workspace_id = p.workspace_id AND c.prompt_id = p.id), '[]'::jsonb),
        'entityVersion', p.entity_version,
        'archivedAt', CASE WHEN p.archived_at IS NULL THEN NULL ELSE ${ISO("p.archived_at")} END,
        'createdAt', ${ISO("p.created_at")}, 'updatedAt', ${ISO("p.updated_at")}
      )) AS record
      FROM team_prompts p WHERE p.workspace_id = $1
    UNION ALL
    SELECT 'b-revision', r.id, jsonb_build_object('entity', 'revision', 'value', jsonb_build_object(
        'id', r.id, 'workspaceId', r.workspace_id, 'promptId', r.prompt_id,
        'parentRevisionId', r.parent_revision_id, 'content', r.content, 'contentFormat', 'markdown',
        'contentHash', r.content_hash, 'changeNote', r.change_note,
        'author', jsonb_build_object(
          'userId', COALESCE(r.author_user_id::text, ''),
          'displayName', CASE WHEN r.author_user_id IS NOT NULL THEN COALESCE(u.display_name, 'Former member') ELSE 'Agent' END,
          'agentTokenId', r.author_agent_id),
        'createdAt', ${ISO("r.created_at")}
      ))
      FROM team_revisions r
      JOIN team_publications pub ON pub.workspace_id = r.workspace_id AND pub.revision_id = r.id
      LEFT JOIN team_users u ON u.id = r.author_user_id
      WHERE r.workspace_id = $1
    UNION ALL
    SELECT 'c-tag', x.id, jsonb_build_object('entity', 'tag', 'value', jsonb_build_object(
        'id', x.id, 'workspaceId', x.workspace_id, 'name', x.name, 'entityVersion', x.entity_version))
      FROM team_tags x WHERE x.workspace_id = $1
    UNION ALL
    SELECT 'd-collection', x.id, jsonb_build_object('entity', 'collection', 'value', jsonb_build_object(
        'id', x.id, 'workspaceId', x.workspace_id, 'name', x.name, 'entityVersion', x.entity_version))
      FROM team_collections x WHERE x.workspace_id = $1
  ) combined
  WHERE record IS NOT NULL`;
