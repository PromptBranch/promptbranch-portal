import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { assertContentWithinBytes } from "../content/scan.js";

/**
 * Immutable revisions (contract §C3): content/hash/parent/author never
 * change after insert (the P1 trigger enforces it). Candidates are just
 * revisions without a publication row — nothing about a candidate ever
 * enters publications, search or (from P5) the feed.
 */

/** contentHash = lowercase SHA-256 of UTF-8 content — server-computed always. */
export function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface InsertRevisionInput {
  workspaceId: string;
  promptId: string;
  parentRevisionId: string | null;
  content: string;
  changeNote: string;
  actor: Principal;
  /** Preallocated id (the seed path mints prompt+revision ids together). */
  revisionId?: string;
}

export interface InsertedRevision {
  revisionId: string;
  contentHash: string;
}

export async function insertRevision(tx: PoolClient, input: InsertRevisionInput): Promise<InsertedRevision> {
  assertContentWithinBytes(input.content);
  const revisionId = input.revisionId ?? randomUUID();
  await tx.query(
    `INSERT INTO team_revisions
       (id, workspace_id, prompt_id, parent_revision_id, content, content_hash, change_note, author_user_id, author_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      revisionId,
      input.workspaceId,
      input.promptId,
      input.parentRevisionId,
      input.content,
      contentHashOf(input.content),
      input.changeNote,
      input.actor.kind === "human" ? input.actor.userId : null,
      input.actor.kind === "agent" ? input.actor.tokenId : null,
    ],
  );
  return { revisionId, contentHash: contentHashOf(input.content) };
}

export interface RevisionDto {
  id: string;
  workspaceId: string;
  promptId: string;
  parentRevisionId: string | null;
  content: string;
  contentFormat: "markdown";
  contentHash: string;
  changeNote: string;
  author: { userId: string; displayName: string; agentTokenId: string | null };
  createdAt: string;
}

interface RevisionRow {
  id: string;
  workspace_id: string;
  prompt_id: string;
  parent_revision_id: string | null;
  content: string;
  content_hash: string;
  change_note: string;
  created_at: Date;
  author_user_id: string | null;
  author_agent_id: string | null;
  agent_owner_user_id: string | null;
  agent_owner_name: string | null;
  author_name: string | null;
}

export const REVISION_SELECT = `
  SELECT r.id, r.workspace_id, r.prompt_id, r.parent_revision_id, r.content, r.content_hash,
         r.change_note, r.created_at, r.author_user_id, r.author_agent_id,
         u.display_name AS author_name,
         t.owner_user_id AS agent_owner_user_id, owner.display_name AS agent_owner_name
    FROM team_revisions r
    LEFT JOIN team_users u ON u.id = r.author_user_id
    LEFT JOIN team_agent_tokens t ON t.id = r.author_agent_id
    LEFT JOIN team_users owner ON owner.id = t.owner_user_id`;

export function toRevisionDto(row: RevisionRow): RevisionDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    promptId: row.prompt_id,
    parentRevisionId: row.parent_revision_id,
    content: row.content,
    contentFormat: "markdown",
    contentHash: row.content_hash,
    changeNote: row.change_note,
    author: {
      userId: row.author_user_id ?? row.agent_owner_user_id ?? "",
      displayName: row.author_name ?? row.agent_owner_name ?? "Former member",
      agentTokenId: row.author_agent_id,
    },
    createdAt: row.created_at.toISOString(),
  };
}

/** Loads ONE revision inside a workspace tx; 404 for foreign/missing ids. */
export async function loadRevision(tx: PoolClient, workspaceId: string, revisionId: string): Promise<RevisionRow> {
  const result = await tx.query<RevisionRow>(`${REVISION_SELECT} WHERE r.workspace_id = $1 AND r.id = $2`, [
    workspaceId,
    revisionId,
  ]);
  const row = result.rows[0];
  if (!row) throw teamError("NOT_FOUND", "Revision not found");
  return row;
}

/** Loads one revision joined with its publication row (published only). */
export async function loadPublishedRevision(
  tx: PoolClient,
  workspaceId: string,
  revisionId: string,
): Promise<RevisionRow> {
  const result = await tx.query<RevisionRow>(
    `${REVISION_SELECT}
       JOIN team_publications p ON p.workspace_id = r.workspace_id AND p.revision_id = r.id
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [workspaceId, revisionId],
  );
  const row = result.rows[0];
  // Publication is the difference between catalogue content and a private
  // candidate — visibility checks the publication, never the prompt alone.
  if (!row) throw teamError("NOT_FOUND", "Revision not found");
  return row;
}

export type { RevisionRow };
