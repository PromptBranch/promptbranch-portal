import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { appendAudit } from "./audit.js";
import { scanTeamContent } from "../content/scan.js";

/**
 * Notes and sanitized run summaries (contract §C3/C4): attach only to
 * ALREADY-PUBLISHED revisions of the referenced prompt — enforced by the
 * P1 composite FKs ((workspace, prompt, revision) → revisions and
 * (workspace, revision) → publications), so a candidate or cross-prompt
 * target cannot store activity even if this module forgot to check. Run
 * metrics are finite non-negative or null; full outputs, variables and
 * provider keys never enter storage. Activity is collaboration data: it is
 * never emitted to the catalogue feed.
 */

export type ActivityKind = "note" | "run";

export interface RunMetrics {
  model: string | null;
  status: "completed" | "failed" | "cancelled";
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface AddActivityInput {
  workspaceId: string;
  actor: Principal;
  promptId: string;
  revisionId: string;
  body: string;
  run: RunMetrics | null;
}

export async function addActivityItem(tx: PoolClient, input: AddActivityInput): Promise<{ activityItemId: string }> {
  scanTeamContent({ body: input.body });
  if (input.run) {
    const { run } = input;
    for (const value of [run.latencyMs, run.inputTokens, run.outputTokens, run.estimatedCostUsd]) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw teamError("VALIDATION_FAILED", "Run metrics must be finite non-negative numbers or null");
      }
    }
    if (run.model !== null && run.model.length === 0) {
      throw teamError("VALIDATION_FAILED", "model must be a non-empty string or null");
    }
  }
  const kind: ActivityKind = input.run ? "run" : "note";
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO team_activity_items (workspace_id, prompt_id, revision_id, kind, body, run_json, author_user_id, author_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        input.workspaceId,
        input.promptId,
        input.revisionId,
        kind,
        input.body,
        input.run ? JSON.stringify(input.run) : null,
        input.actor.kind === "human" ? input.actor.userId : null,
        input.actor.kind === "agent" ? input.actor.tokenId : null,
      ],
    ).catch((error: { code?: string }) => {
      // 23503: the target revision is not a published revision of this
      // prompt (or the prompt is foreign) — uniform NOT_FOUND, no leakage.
      if (error.code === "23503") {
        throw teamError("NOT_FOUND", "Revision not found for this prompt");
      }
      throw error;
    })
  ).rows[0]!.id;
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: kind === "note" ? "note.add" : "run.report",
    resourceType: "activityItem",
    resourceId: id,
    metadata: { promptId: input.promptId, revisionId: input.revisionId },
  });
  return { activityItemId: id };
}

export interface ActivityItemDto {
  id: string;
  workspaceId: string;
  promptId: string;
  revisionId: string;
  kind: ActivityKind;
  body: string;
  createdAt: string;
  author: { userId: string; displayName: string; agentTokenId: string | null };
  run: RunMetrics | null;
}

/** Contributor+ humans see the workspace's activity; agents see only their own. */
export async function listActivityItems(
  pool: Pool,
  input: { workspaceId: string; viewer: Principal; promptId?: string; limit?: number; pageToken?: string },
): Promise<{ items: ActivityItemDto[]; nextPageToken: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  let offset = 0;
  if (input.pageToken) {
    const decoded = Buffer.from(input.pageToken, "base64url").toString("utf8");
    offset = Number(decoded);
    if (!Number.isInteger(offset) || offset < 0) throw teamError("VALIDATION_FAILED", "Invalid page token");
  }
  const params: unknown[] = [input.workspaceId, limit + 1, offset];
  if (input.promptId) params.push(input.promptId);
  const promptFilter = input.promptId ? ` AND a.prompt_id = $${params.length}` : "";
  const ownFilter =
    input.viewer.kind === "agent"
      ? ` AND a.author_agent_id = $${params.length + 1}`
      : "";
  if (input.viewer.kind === "agent") params.push(input.viewer.tokenId);

  const result = await pool.query<{
    id: string;
    prompt_id: string;
    revision_id: string;
    kind: ActivityKind;
    body: string;
    run_json: RunMetrics | null;
    created_at: Date;
    author_user_id: string | null;
    author_agent_id: string | null;
    author_name: string | null;
  }>(
    `SELECT a.id, a.prompt_id, a.revision_id, a.kind, a.body, a.run_json, a.created_at,
            a.author_user_id, a.author_agent_id,
            CASE WHEN a.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name
       FROM team_activity_items a
       LEFT JOIN team_users u ON u.id = a.author_user_id
      WHERE a.workspace_id = $1${promptFilter}${ownFilter}
      ORDER BY a.created_at DESC, a.id
      LIMIT $2 OFFSET $3`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map((row) => ({
    id: row.id,
    workspaceId: input.workspaceId,
    promptId: row.prompt_id,
    revisionId: row.revision_id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    author: {
      userId: row.author_user_id ?? "",
      displayName: row.author_name ?? "Former member",
      agentTokenId: row.author_agent_id,
    },
    run: row.run_json,
  }));
  return { items, nextPageToken: hasMore ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : null };
}
