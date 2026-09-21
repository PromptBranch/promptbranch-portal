import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { appendAudit } from "./audit.js";
import { insertRevision, loadRevision, loadPublishedRevision, toRevisionDto, type RevisionDto } from "./revisions.js";
import { scanTeamContent, assertContentWithinBytes } from "../content/scan.js";

/**
 * Approved prompt library (contract §C3): creating a prompt is a
 * maintainer-authorized seed that atomically creates its first APPROVED
 * revision and publication; every subsequent content change rides a
 * proposal. The approved-head pointer moves only through publication rows —
 * candidates never touch publications, the search index, or (P5) the feed.
 */

export interface PromptDto {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  approvedRevisionId: string | null;
  tagIds: string[];
  collectionIds: string[];
  entityVersion: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PromptRow {
  id: string;
  title: string;
  description: string;
  approved_revision_id: string | null;
  entity_version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function loadPrompt(tx: PoolClient, workspaceId: string, promptId: string): Promise<PromptRow> {
  const result = await tx.query<PromptRow>(
    "SELECT id, title, description, approved_revision_id, entity_version, archived_at, created_at, updated_at FROM team_prompts WHERE workspace_id = $1 AND id = $2",
    [workspaceId, promptId],
  );
  const row = result.rows[0];
  if (!row) throw teamError("NOT_FOUND", "Prompt not found");
  return row;
}

async function junctionIds(tx: PoolClient, workspaceId: string, promptId: string): Promise<{ tagIds: string[]; collectionIds: string[] }> {
  const [tags, collections] = await Promise.all([
    tx.query<{ id: string }>("SELECT tag_id AS id FROM team_prompt_tags WHERE workspace_id = $1 AND prompt_id = $2 ORDER BY tag_id", [workspaceId, promptId]),
    tx.query<{ id: string }>("SELECT collection_id AS id FROM team_collection_prompts WHERE workspace_id = $1 AND prompt_id = $2 ORDER BY collection_id", [workspaceId, promptId]),
  ]);
  return { tagIds: tags.rows.map((r) => r.id), collectionIds: collections.rows.map((r) => r.id) };
}

async function replaceJunctions(
  tx: PoolClient,
  workspaceId: string,
  promptId: string,
  tagIds: string[],
  collectionIds: string[],
): Promise<void> {
  // Cross-workspace or unknown ids fail the composite FK — exactly the
  // isolation the schema was built for.
  await tx.query("DELETE FROM team_prompt_tags WHERE workspace_id = $1 AND prompt_id = $2", [workspaceId, promptId]);
  await tx.query("DELETE FROM team_collection_prompts WHERE workspace_id = $1 AND prompt_id = $2", [workspaceId, promptId]);
  for (const tagId of new Set(tagIds)) {
    await tx.query("INSERT INTO team_prompt_tags (workspace_id, prompt_id, tag_id) VALUES ($1, $2, $3)", [workspaceId, promptId, tagId]);
  }
  for (const collectionId of new Set(collectionIds)) {
    await tx.query("INSERT INTO team_collection_prompts (workspace_id, prompt_id, collection_id) VALUES ($1, $2, $3)", [workspaceId, promptId, collectionId]);
  }
}

/**
 * Maintains the published search projection: title/description (weighted
 * first) plus the CURRENT approved revision content only. Called from the
 * same transaction as every head/metadata mutation.
 */
export async function refreshPromptSearch(tx: PoolClient, workspaceId: string, promptId: string): Promise<void> {
  await tx.query(
    `INSERT INTO team_prompt_search (workspace_id, prompt_id, tsv)
     SELECT p.workspace_id, p.id,
            setweight(to_tsvector('simple', coalesce(p.title, '')), 'A')
         || setweight(to_tsvector('simple', coalesce(p.description, '')), 'B')
         || setweight(to_tsvector('simple', coalesce(r.content, '')), 'C')
       FROM team_prompts p
       LEFT JOIN team_revisions r ON r.workspace_id = p.workspace_id AND r.id = p.approved_revision_id
      WHERE p.workspace_id = $1 AND p.id = $2
     ON CONFLICT (workspace_id, prompt_id) DO UPDATE
       SET tsv = EXCLUDED.tsv`,
    [workspaceId, promptId],
  );
}

/** prompt.create — the seed path: prompt + first approved revision + publication atomically. */
export async function seedPrompt(
  tx: PoolClient,
  input: {
    workspaceId: string;
    actor: Principal;
    title: string;
    description: string;
    content: string;
    tagIds: string[];
    collectionIds: string[];
    changeNote: string;
  },
): Promise<{ promptId: string; revisionId: string; entityVersion: number }> {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) throw teamError("VALIDATION_FAILED", "Title must be 1-200 characters after trimming");
  assertContentWithinBytes(input.content);
  scanTeamContent({ title, description: input.description, content: input.content, changeNote: input.changeNote });

  // Insert order exploits the deferrable head FK: the prompt row first —
  // already pointing at the revision id minted alongside it — then the
  // revision, whose (workspace, prompt) FK needs the prompt to exist. At no
  // point does an observable unapproved head survive: the whole seed is one
  // transaction.
  const promptId = randomUUID();
  const revisionId = randomUUID();
  await insertPromptRow(tx, input.workspaceId, promptId, title, input.description, revisionId);
  await insertRevision(tx, {
    workspaceId: input.workspaceId,
    promptId,
    revisionId,
    parentRevisionId: null,
    content: input.content,
    changeNote: input.changeNote || "initial seed",
    actor: input.actor,
  });
  await tx.query(
    `INSERT INTO team_publications (workspace_id, revision_id, prompt_id, source)
     VALUES ($1, $2, $3, 'seed')`,
    [input.workspaceId, revisionId, promptId],
  );
  await replaceJunctions(tx, input.workspaceId, promptId, input.tagIds, input.collectionIds);
  await refreshPromptSearch(tx, input.workspaceId, promptId);
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "prompt.create",
    resourceType: "prompt",
    resourceId: promptId,
  });
  const row = await loadPrompt(tx, input.workspaceId, promptId);
  return { promptId, revisionId, entityVersion: row.entity_version };
}

async function insertPromptRow(
  tx: PoolClient,
  workspaceId: string,
  promptId: string,
  title: string,
  description: string,
  approvedRevisionId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO team_prompts (workspace_id, id, title, description, approved_revision_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, promptId, title, description, approvedRevisionId],
  );
}

/** prompt.metadata — content never piggybacks on metadata commands. */
export async function updatePromptMetadata(
  tx: PoolClient,
  input: {
    workspaceId: string;
    actor: Principal;
    promptId: string;
    title: string;
    description: string;
    tagIds: string[];
    collectionIds: string[];
    expectedEntityVersion: number;
  },
): Promise<{ entityVersion: number }> {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) throw teamError("VALIDATION_FAILED", "Title must be 1-200 characters after trimming");
  scanTeamContent({ title, description: input.description });
  await loadPrompt(tx, input.workspaceId, input.promptId);
  const updated = await tx.query<{ entity_version: number }>(
    `UPDATE team_prompts
        SET title = $3, description = $4, entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND entity_version = $5
      RETURNING entity_version`,
    [input.workspaceId, input.promptId, title, input.description, input.expectedEntityVersion],
  );
  if (!updated.rows[0]) throw teamError("STALE_ENTITY", "Prompt changed; refresh and retry");
  await replaceJunctions(tx, input.workspaceId, input.promptId, input.tagIds, input.collectionIds);
  await refreshPromptSearch(tx, input.workspaceId, input.promptId);
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "prompt.metadata",
    resourceType: "prompt",
    resourceId: input.promptId,
  });
  return { entityVersion: updated.rows[0].entity_version };
}

/** prompt.archive / prompt.restore — archived prompts stay in the catalogue but leave browse/search. */
export async function setPromptArchived(
  tx: PoolClient,
  input: { workspaceId: string; actor: Principal; promptId: string; archived: boolean; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  await loadPrompt(tx, input.workspaceId, input.promptId);
  const updated = await tx.query<{ entity_version: number }>(
    `UPDATE team_prompts
        SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END,
            entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND entity_version = $4
      RETURNING entity_version`,
    [input.workspaceId, input.promptId, input.archived, input.expectedEntityVersion],
  );
  if (!updated.rows[0]) throw teamError("STALE_ENTITY", "Prompt changed; refresh and retry");
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: input.archived ? "prompt.archive" : "prompt.restore",
    resourceType: "prompt",
    resourceId: input.promptId,
  });
  return { entityVersion: updated.rows[0].entity_version };
}

/** prompt.rollback — move the head to an ALREADY-PUBLISHED revision; history is never edited. */
export async function rollbackPrompt(
  tx: PoolClient,
  input: {
    workspaceId: string;
    actor: Principal;
    promptId: string;
    targetRevisionId: string;
    expectedApprovedRevisionId: string;
    reason: string;
  },
): Promise<{ entityVersion: number }> {
  scanTeamContent({ reason: input.reason });
  const prompt = await loadPrompt(tx, input.workspaceId, input.promptId);
  if (prompt.archived_at) throw teamError("STALE_ENTITY", "Prompt is archived; restore it first");
  const target = await loadPublishedRevision(tx, input.workspaceId, input.targetRevisionId);
  if (target.prompt_id !== input.promptId) throw teamError("NOT_FOUND", "Revision not found");
  if (prompt.approved_revision_id !== input.expectedApprovedRevisionId) {
    throw teamError("STALE_BASE", "The approved head moved; refresh and retry");
  }
  const updated = await tx.query<{ entity_version: number }>(
    `UPDATE team_prompts
        SET approved_revision_id = $3, entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING entity_version`,
    [input.workspaceId, input.promptId, input.targetRevisionId],
  );
  await refreshPromptSearch(tx, input.workspaceId, input.promptId);
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "prompt.rollback",
    resourceType: "prompt",
    resourceId: input.promptId,
    metadata: { targetRevisionId: input.targetRevisionId },
  });
  return { entityVersion: updated.rows[0]!.entity_version };
}

// ---------------------------------------------------------------------------
// Catalogue reads (member-only surfaces; candidates never appear here)
// ---------------------------------------------------------------------------

function toPromptDto(row: PromptRow, workspaceId: string, tagIds: string[], collectionIds: string[]): PromptDto {
  return {
    id: row.id,
    workspaceId,
    title: row.title,
    description: row.description,
    approvedRevisionId: row.approved_revision_id,
    tagIds,
    collectionIds,
    entityVersion: row.entity_version,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ListPromptsInput {
  q?: string;
  tagId?: string;
  collectionId?: string;
  archived?: boolean;
  limit?: number;
  pageToken?: string;
}

/** Browse/search over APPROVED content only, stable title/id order. */
export async function listPrompts(pool: Pool, workspaceId: string, input: ListPromptsInput): Promise<{ items: PromptDto[]; nextPageToken: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = decodePageToken(input.pageToken);
  if (input.q !== undefined && Buffer.byteLength(input.q, "utf8") > 200) {
    throw teamError("VALIDATION_FAILED", "Search query exceeds 200 characters");
  }
  const archived = input.archived ?? false;
  const params: unknown[] = [workspaceId, archived, limit + 1, offset];
  // Search hits the tsvector projection (title/description + APPROVED head
  // content only) — candidate text cannot match because it never enters it.
  const searchJoin =
    input.q !== undefined && input.q.trim().length > 0
      ? "JOIN team_prompt_search s ON s.workspace_id = p.workspace_id AND s.prompt_id = p.id AND s.tsv @@ websearch_to_tsquery('simple', $5::text)"
      : "";
  if (searchJoin) params.push(input.q);
  const tagFilter = input.tagId ? "AND EXISTS (SELECT 1 FROM team_prompt_tags t WHERE t.workspace_id = p.workspace_id AND t.prompt_id = p.id AND t.tag_id = $6)" : "";
  if (input.tagId) params.push(input.tagId);
  const collectionFilter = input.collectionId
    ? "AND EXISTS (SELECT 1 FROM team_collection_prompts c WHERE c.workspace_id = p.workspace_id AND c.prompt_id = p.id AND c.collection_id = $7)"
    : "";
  if (input.collectionId) params.push(input.collectionId);

  const result = await pool.query<PromptRow>(
    `SELECT p.id, p.title, p.description, p.approved_revision_id, p.entity_version, p.archived_at, p.created_at, p.updated_at
       FROM team_prompts p
       ${searchJoin}
      WHERE p.workspace_id = $1 AND (p.archived_at IS NOT NULL) = $2
        ${tagFilter} ${collectionFilter}
      ORDER BY p.title, p.id
      LIMIT $3 OFFSET $4`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const ids = rows.map((row) => row.id);
  const [tags, collections] = ids.length
    ? await Promise.all([
        pool.query<{ prompt_id: string; tag_id: string }>(
          `SELECT prompt_id, tag_id FROM team_prompt_tags WHERE workspace_id = $1 AND prompt_id = ANY($2) ORDER BY tag_id`,
          [workspaceId, ids],
        ),
        pool.query<{ prompt_id: string; collection_id: string }>(
          `SELECT prompt_id, collection_id FROM team_collection_prompts WHERE workspace_id = $1 AND prompt_id = ANY($2) ORDER BY collection_id`,
          [workspaceId, ids],
        ),
      ])
    : [{ rows: [] as { prompt_id: string; tag_id: string }[] }, { rows: [] as { prompt_id: string; collection_id: string }[] }];
  const items = rows.map((row) =>
    toPromptDto(
      row,
      workspaceId,
      tags.rows.filter((t) => t.prompt_id === row.id).map((t) => t.tag_id),
      collections.rows.filter((c) => c.prompt_id === row.id).map((c) => c.collection_id),
    ),
  );
  return { items, nextPageToken: hasMore ? encodePageToken(offset + limit) : null };
}

function encodePageToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodePageToken(token?: string): number {
  if (!token) return 0;
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const offset = Number(decoded);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw teamError("VALIDATION_FAILED", "Invalid page token");
  }
  return offset;
}

/** GET /prompts/:p — approved prompt + its approved head revision. */
export async function getPromptWithHead(pool: Pool, workspaceId: string, promptId: string): Promise<{ prompt: PromptDto; revision: RevisionDto }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prompt = await loadPrompt(client, workspaceId, promptId);
    const [junction, headRow] = await Promise.all([
      junctionIds(client, workspaceId, promptId),
      prompt.approved_revision_id
        ? loadPublishedRevision(client, workspaceId, prompt.approved_revision_id)
        : Promise.resolve(null),
    ]);
    await client.query("COMMIT");
    if (!headRow) throw teamError("NOT_FOUND", "Prompt not found");
    return {
      prompt: toPromptDto(prompt, workspaceId, junction.tagIds, junction.collectionIds),
      revision: toRevisionDto(headRow),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Published history, newest first — candidates are structurally absent. */
export async function listPublishedRevisions(
  pool: Pool,
  workspaceId: string,
  promptId: string,
  input: { limit?: number; pageToken?: string },
): Promise<{ items: RevisionDto[]; nextPageToken: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = decodePageToken(input.pageToken);
  const result = await pool.query(
    `SELECT r.id, r.workspace_id, r.prompt_id, r.parent_revision_id, r.content, r.content_hash,
            r.change_note, r.created_at, r.author_user_id, r.author_agent_id,
            CASE WHEN r.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name
       FROM team_revisions r
       JOIN team_publications p ON p.workspace_id = r.workspace_id AND p.revision_id = r.id
       LEFT JOIN team_users u ON u.id = r.author_user_id
      WHERE r.workspace_id = $1 AND r.prompt_id = $2
      ORDER BY r.created_at DESC, r.id
      LIMIT $3 OFFSET $4`,
    [workspaceId, promptId, limit + 1, offset],
  );
  const hasMore = result.rows.length > limit;
  const items = (result.rows.slice(0, limit) as import("./revisions.js").RevisionRow[]).map(toRevisionDto);
  return { items, nextPageToken: hasMore ? encodePageToken(offset + limit) : null };
}

/** GET /revisions/:r — publication verified, never mere prompt visibility. */
export async function getPublishedRevisionDto(pool: Pool, workspaceId: string, revisionId: string): Promise<RevisionDto> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await loadPublishedRevision(client, workspaceId, revisionId);
    await client.query("COMMIT");
    return toRevisionDto(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export { loadPrompt, junctionIds };
