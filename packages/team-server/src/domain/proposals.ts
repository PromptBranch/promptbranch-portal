import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { appendAudit } from "./audit.js";
import { insertRevision, loadPublishedRevision, toRevisionDto, type RevisionDto } from "./revisions.js";
import { refreshPromptSearch } from "./prompts.js";
import { scanTeamContent } from "../content/scan.js";

/**
 * Reviewed changes (contract §C3): submission inserts an immutable candidate
 * revision and an open proposal — never a publication or search row.
 * Approval requires head = base = expectedApprovedRevisionId and the exact
 * candidate id/hash, written by a DISTINCT human maintainer; the review,
 * publication, head move, search update, audit and receipt all land in one
 * transaction. Reject never moves the head. Supersession closes the old open
 * proposal and opens the replacement atomically; withdrawal, rejection and
 * approval are terminal.
 */

export type ProposalStatus = "open" | "approved" | "rejected" | "withdrawn" | "superseded";

export interface ProposalRow {
  id: string;
  prompt_id: string;
  base_revision_id: string;
  candidate_revision_id: string;
  author_user_id: string | null;
  author_agent_id: string | null;
  rationale: string;
  status: ProposalStatus;
  supersedes_id: string | null;
  entity_version: number;
}

async function loadProposal(tx: PoolClient, workspaceId: string, proposalId: string): Promise<ProposalRow> {
  const result = await tx.query<ProposalRow>(
    `SELECT id, prompt_id, base_revision_id, candidate_revision_id, author_user_id, author_agent_id,
            rationale, status, supersedes_id, entity_version
       FROM team_proposals
      WHERE workspace_id = $1 AND id = $2
      FOR UPDATE`,
    [workspaceId, proposalId],
  );
  const row = result.rows[0];
  if (!row) throw teamError("NOT_FOUND", "Proposal not found");
  return row;
}

/** The human behind a proposal: direct author or an agent token's owner. */
async function proposalHumanAuthor(tx: PoolClient, proposal: ProposalRow): Promise<string | null> {
  if (proposal.author_user_id) return proposal.author_user_id;
  const agent = await tx.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM team_agent_tokens WHERE id = $1",
    [proposal.author_agent_id],
  );
  return agent.rows[0]?.owner_user_id ?? null;
}

function assertOwnProposal(proposal: ProposalRow, actor: Principal): void {
  const owns =
    actor.kind === "human"
      ? proposal.author_user_id === actor.userId
      : proposal.author_agent_id === actor.tokenId;
  if (!owns) throw teamError("NOT_FOUND", "Proposal not found");
}

/** proposal.submit — contributor path; optionally supersedes the author's open proposal. */
export async function submitProposal(
  tx: PoolClient,
  input: {
    workspaceId: string;
    actor: Principal;
    promptId: string;
    baseRevisionId: string;
    content: string;
    rationale: string;
    supersedesProposalId: string | null;
  },
): Promise<{ proposalId: string; candidateRevisionId: string; entityVersion: number; mediumFindings: unknown[] }> {
  const medium = scanTeamContent({ content: input.content, rationale: input.rationale });

  const prompt = await tx.query<{ id: string; archived_at: Date | null; approved_revision_id: string | null }>(
    "SELECT id, archived_at, approved_revision_id FROM team_prompts WHERE workspace_id = $1 AND id = $2",
    [input.workspaceId, input.promptId],
  );
  const promptRow = prompt.rows[0];
  if (!promptRow) throw teamError("NOT_FOUND", "Prompt not found");
  if (promptRow.archived_at) throw teamError("STALE_ENTITY", "Prompt is archived; restore it first");

  // The base must be a PUBLISHED revision of this prompt (older heads are
  // legal — the proposal is simply marked stale in the UI).
  const base = await loadPublishedRevision(tx, input.workspaceId, input.baseRevisionId);
  if (base.prompt_id !== input.promptId) throw teamError("NOT_FOUND", "Base revision not found");

  if (input.supersedesProposalId) {
    const old = await loadProposal(tx, input.workspaceId, input.supersedesProposalId);
    assertOwnProposal(old, input.actor);
    if (old.status !== "open" || old.prompt_id !== input.promptId) {
      throw teamError("STALE_ENTITY", "Only an open proposal on the same prompt can be superseded");
    }
    await tx.query(
      "UPDATE team_proposals SET status = 'superseded', entity_version = entity_version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [input.workspaceId, old.id],
    );
  }

  const candidate = await insertRevision(tx, {
    workspaceId: input.workspaceId,
    promptId: input.promptId,
    parentRevisionId: input.baseRevisionId,
    content: input.content,
    changeNote: input.rationale.slice(0, 200),
    actor: input.actor,
  });
  const inserted = await tx.query<{ id: string; entity_version: number }>(
    `INSERT INTO team_proposals
       (workspace_id, id, prompt_id, base_revision_id, candidate_revision_id, author_user_id, author_agent_id, rationale, supersedes_id)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, entity_version`,
    [
      input.workspaceId,
      input.promptId,
      input.baseRevisionId,
      candidate.revisionId,
      input.actor.kind === "human" ? input.actor.userId : null,
      input.actor.kind === "agent" ? input.actor.tokenId : null,
      input.rationale,
      input.supersedesProposalId,
    ],
  );
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "proposal.submit",
    resourceType: "proposal",
    resourceId: inserted.rows[0]!.id,
  });
  return {
    proposalId: inserted.rows[0]!.id,
    candidateRevisionId: candidate.revisionId,
    entityVersion: inserted.rows[0]!.entity_version,
    mediumFindings: medium.medium,
  };
}

/** proposal.withdraw — own open proposal only; terminal. */
export async function withdrawProposal(
  tx: PoolClient,
  input: { workspaceId: string; actor: Principal; proposalId: string; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  const proposal = await loadProposal(tx, input.workspaceId, input.proposalId);
  assertOwnProposal(proposal, input.actor);
  if (proposal.status !== "open") throw teamError("STALE_ENTITY", "Proposal is already closed");
  if (proposal.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Proposal changed; refresh and retry");
  }
  const updated = await tx.query<{ entity_version: number }>(
    `UPDATE team_proposals SET status = 'withdrawn', entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 RETURNING entity_version`,
    [input.workspaceId, input.proposalId],
  );
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "proposal.withdraw",
    resourceType: "proposal",
    resourceId: input.proposalId,
  });
  return { entityVersion: updated.rows[0]!.entity_version };
}

export interface ReviewOutcome {
  entityVersion: number;
  approvedRevisionId?: string;
}

/** proposal.review — human maintainer, never the author; the approval state machine. */
export async function reviewProposal(
  tx: PoolClient,
  input: {
    workspaceId: string;
    reviewer: Principal;
    proposalId: string;
    expectedEntityVersion: number;
    candidateRevisionId: string;
    candidateContentHash: string;
    expectedApprovedRevisionId: string;
    decision: "approve" | "reject";
    comment: string;
  },
): Promise<ReviewOutcome> {
  if (input.reviewer.kind !== "human") {
    // No agent capability permits reviewing (contract §C1).
    throw teamError("ROLE_FORBIDDEN", "Reviews are performed by human maintainers");
  }
  scanTeamContent({ comment: input.comment });

  const proposal = await loadProposal(tx, input.workspaceId, input.proposalId);
  if (proposal.status !== "open") throw teamError("STALE_ENTITY", "Proposal is already closed");
  if (proposal.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Proposal changed; refresh and retry");
  }
  // Bind the review to the EXACT immutable candidate the reviewer inspected:
  // the presented id must BE the proposal's candidate, then the hash must
  // match that revision's stored hash.
  if (proposal.candidate_revision_id !== input.candidateRevisionId) {
    throw teamError("STALE_ENTITY", "Review must bind the proposal's exact candidate revision and hash");
  }
  const candidate = await tx.query<{ content_hash: string }>(
    "SELECT content_hash FROM team_revisions WHERE workspace_id = $1 AND id = $2 AND prompt_id = $3",
    [input.workspaceId, input.candidateRevisionId, proposal.prompt_id],
  );
  if (!candidate.rows[0] || candidate.rows[0].content_hash !== input.candidateContentHash) {
    throw teamError("STALE_ENTITY", "Review must bind the proposal's exact candidate revision and hash");
  }
  // Self-review is forbidden including through an agent credential.
  const authorHuman = await proposalHumanAuthor(tx, proposal);
  if (authorHuman === input.reviewer.userId) {
    throw teamError("SELF_REVIEW", "The reviewer must differ from the proposal's author");
  }

  const promptRow = await tx.query<{ approved_revision_id: string | null; archived_at: Date | null; id: string }>(
    "SELECT id, approved_revision_id, archived_at FROM team_prompts WHERE workspace_id = $1 AND id = $2",
    [input.workspaceId, proposal.prompt_id],
  );
  const prompt = promptRow.rows[0];
  if (!prompt) throw teamError("NOT_FOUND", "Prompt not found");

  if (input.decision === "reject") {
    // Reject never moves the approved head.
    await tx.query(
      "UPDATE team_proposals SET status = 'rejected', entity_version = entity_version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [input.workspaceId, proposal.id],
    );
    await writeReview(tx, { ...input, proposalId: proposal.id, candidateRevisionId: proposal.candidate_revision_id, candidateContentHash: input.candidateContentHash });
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.reviewer,
      action: "proposal.review",
      resourceType: "proposal",
      resourceId: proposal.id,
      metadata: { decision: "reject" },
    });
    return { entityVersion: proposal.entity_version + 1 };
  }

  // Approval: head = base = expectedApprovedRevisionId, prompt not archived.
  if (prompt.archived_at) throw teamError("STALE_ENTITY", "Prompt is archived; restore it first");
  if (prompt.approved_revision_id !== input.expectedApprovedRevisionId || prompt.approved_revision_id !== proposal.base_revision_id) {
    throw teamError("STALE_BASE", "The approved head moved since this proposal was based on it");
  }

  const reviewId = await writeReview(tx, { ...input, proposalId: proposal.id, candidateRevisionId: proposal.candidate_revision_id, candidateContentHash: input.candidateContentHash });
  await tx.query(
    `INSERT INTO team_publications (workspace_id, revision_id, prompt_id, source, review_id)
     VALUES ($1, $2, $3, 'review', $4)`,
    [input.workspaceId, proposal.candidate_revision_id, proposal.prompt_id, reviewId],
  );
  const updatedPrompt = await tx.query<{ entity_version: number }>(
    `UPDATE team_prompts
        SET approved_revision_id = $3, entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING entity_version`,
    [input.workspaceId, proposal.prompt_id, proposal.candidate_revision_id],
  );
  await tx.query(
    "UPDATE team_proposals SET status = 'approved', entity_version = entity_version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
    [input.workspaceId, proposal.id],
  );
  // Search index sees the new approved content in the SAME transaction.
  await refreshPromptSearch(tx, input.workspaceId, proposal.prompt_id);
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.reviewer,
    action: "proposal.review",
    resourceType: "proposal",
    resourceId: proposal.id,
    metadata: { decision: "approve", revisionId: proposal.candidate_revision_id },
  });
  return { entityVersion: proposal.entity_version + 1, approvedRevisionId: proposal.candidate_revision_id };
}

/** Terminal decision is unique per proposal — the review row closes it. */
async function writeReview(
  tx: PoolClient,
  input: {
    workspaceId: string;
    reviewer: Principal;
    decision: "approve" | "reject";
    comment: string;
    proposalId: string;
    candidateRevisionId: string;
    candidateContentHash: string;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO team_reviews (workspace_id, proposal_id, candidate_revision_id, candidate_hash, reviewer_user_id, decision, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.workspaceId,
      input.proposalId,
      input.candidateRevisionId,
      input.candidateContentHash,
      input.reviewer.kind === "human" ? input.reviewer.userId : "",
      input.decision,
      input.comment,
    ],
  );
  return result.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Reads (contributor+; candidate content only via proposal detail)
// ---------------------------------------------------------------------------

export interface ProposalDto {
  id: string;
  workspaceId: string;
  promptId: string;
  baseRevisionId: string;
  candidateRevisionId: string;
  rationale: string;
  author: { userId: string; displayName: string; agentTokenId: string | null };
  status: ProposalStatus;
  supersedesProposalId: string | null;
  entityVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface ProposalReadRow {
  id: string;
  prompt_id: string;
  base_revision_id: string;
  candidate_revision_id: string;
  rationale: string;
  status: ProposalStatus;
  supersedes_id: string | null;
  entity_version: number;
  created_at: Date;
  updated_at: Date;
  author_user_id: string | null;
  author_agent_id: string | null;
  author_name: string | null;
}

const PROPOSAL_SELECT = `
  SELECT pr.id, pr.prompt_id, pr.base_revision_id, pr.candidate_revision_id, pr.rationale, pr.status,
         pr.supersedes_id, pr.entity_version, pr.created_at, pr.updated_at,
         pr.author_user_id, pr.author_agent_id,
         CASE WHEN pr.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name
    FROM team_proposals pr
    LEFT JOIN team_users u ON u.id = pr.author_user_id`;

function toProposalDto(row: ProposalReadRow, workspaceId: string): ProposalDto {
  return {
    id: row.id,
    workspaceId,
    promptId: row.prompt_id,
    baseRevisionId: row.base_revision_id,
    candidateRevisionId: row.candidate_revision_id,
    rationale: row.rationale,
    author: {
      userId: row.author_user_id ?? "",
      displayName: row.author_name ?? "Former member",
      agentTokenId: row.author_agent_id,
    },
    status: row.status,
    supersedesProposalId: row.supersedes_id,
    entityVersion: row.entity_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listProposals(
  pool: Pool,
  workspaceId: string,
  input: { promptId?: string; status?: ProposalStatus; limit?: number; pageToken?: string },
): Promise<{ items: ProposalDto[]; nextPageToken: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Number(
    input.pageToken ? Buffer.from(input.pageToken, "base64url").toString("utf8") : "0",
  );
  if (!Number.isInteger(offset) || offset < 0) throw teamError("VALIDATION_FAILED", "Invalid page token");
  const params: unknown[] = [workspaceId, limit + 1, offset];
  let filter = "";
  if (input.promptId) {
    params.push(input.promptId);
    filter += ` AND pr.prompt_id = $${params.length}`;
  }
  if (input.status) {
    params.push(input.status);
    filter += ` AND pr.status = $${params.length}`;
  }
  const result = await pool.query<ProposalReadRow>(
    `${PROPOSAL_SELECT} WHERE pr.workspace_id = $1${filter} ORDER BY pr.updated_at DESC, pr.id LIMIT $2 OFFSET $3`,
    params,
  );
  const hasMore = result.rows.length > limit;
  return {
    items: result.rows.slice(0, limit).map((row) => toProposalDto(row, workspaceId)),
    nextPageToken: hasMore ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : null,
  };
}

export interface ProposalDetail {
  proposal: ProposalDto;
  base: RevisionDto;
  candidate: RevisionDto;
  reviews: Array<{
    id: string;
    proposalId: string;
    candidateRevisionId: string;
    candidateContentHash: string;
    reviewer: { userId: string; displayName: string; agentTokenId: null };
    decision: "approve" | "reject";
    comment: string;
    createdAt: string;
  }>;
}

export async function getProposalDetail(pool: Pool, workspaceId: string, proposalId: string): Promise<ProposalDetail> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proposal = (await client.query<ProposalReadRow>(`${PROPOSAL_SELECT} WHERE pr.workspace_id = $1 AND pr.id = $2`, [workspaceId, proposalId])).rows[0];
    if (!proposal) throw teamError("NOT_FOUND", "Proposal not found");
    const [base, candidate, reviews] = await Promise.all([
      client.query(`${"SELECT r.id, r.workspace_id, r.prompt_id, r.parent_revision_id, r.content, r.content_hash, r.change_note, r.created_at, r.author_user_id, r.author_agent_id, CASE WHEN r.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name FROM team_revisions r LEFT JOIN team_users u ON u.id = r.author_user_id"} WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, proposal.base_revision_id]),
      client.query(`${"SELECT r.id, r.workspace_id, r.prompt_id, r.parent_revision_id, r.content, r.content_hash, r.change_note, r.created_at, r.author_user_id, r.author_agent_id, CASE WHEN r.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name FROM team_revisions r LEFT JOIN team_users u ON u.id = r.author_user_id"} WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, proposal.candidate_revision_id]),
      client.query(`
        SELECT v.id, v.proposal_id, v.candidate_revision_id, v.candidate_hash, v.decision, v.comment, v.created_at,
               v.reviewer_user_id, u.display_name AS reviewer_name
          FROM team_reviews v
          LEFT JOIN team_users u ON u.id = v.reviewer_user_id
         WHERE v.workspace_id = $1 AND v.proposal_id = $2
         ORDER BY v.created_at`, [workspaceId, proposalId]),
    ]);
    await client.query("COMMIT");
    if (!base.rows[0] || !candidate.rows[0]) throw teamError("NOT_FOUND", "Proposal not found");
    return {
      proposal: toProposalDto(proposal, workspaceId),
      base: toRevisionDto(base.rows[0] as import("./revisions.js").RevisionRow),
      candidate: toRevisionDto(candidate.rows[0] as import("./revisions.js").RevisionRow),
      reviews: reviews.rows.map((row: { id: string; proposal_id: string; candidate_revision_id: string; candidate_hash: string; decision: "approve" | "reject"; comment: string; created_at: Date; reviewer_user_id: string; reviewer_name: string | null }) => ({
        id: row.id,
        proposalId: row.proposal_id,
        candidateRevisionId: row.candidate_revision_id,
        candidateContentHash: row.candidate_hash,
        reviewer: { userId: row.reviewer_user_id, displayName: row.reviewer_name ?? "Former member", agentTokenId: null },
        decision: row.decision,
        comment: row.comment,
        createdAt: row.created_at.toISOString(),
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** comment.add — contributor; append-only by trigger. */
export async function addComment(
  tx: PoolClient,
  input: { workspaceId: string; actor: Principal; proposalId: string; body: string },
): Promise<{ commentId: string }> {
  scanTeamContent({ body: input.body });
  const proposal = await loadProposal(tx, input.workspaceId, input.proposalId);
  if (proposal.status === "superseded" || proposal.status === "withdrawn" || proposal.status === "approved") {
    // Discussion stays possible on open and rejected proposals; the other
    // terminal states keep their history frozen.
    throw teamError("STALE_ENTITY", "This proposal no longer accepts comments");
  }
  const id = (await tx.query<{ id: string }>(
    `INSERT INTO team_comments (workspace_id, proposal_id, author_user_id, author_agent_id, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.workspaceId,
      input.proposalId,
      input.actor.kind === "human" ? input.actor.userId : null,
      input.actor.kind === "agent" ? input.actor.tokenId : null,
      input.body,
    ],
  )).rows[0]!.id;
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "comment.add",
    resourceType: "comment",
    resourceId: id,
    metadata: { proposalId: input.proposalId },
  });
  return { commentId: id };
}

export async function listComments(
  pool: Pool,
  workspaceId: string,
  proposalId: string,
): Promise<Array<{ id: string; proposalId: string; body: string; author: { userId: string; displayName: string; agentTokenId: string | null }; createdAt: string }>> {
  const result = await pool.query(`
    SELECT c.id, c.proposal_id, c.body, c.created_at, c.author_user_id, c.author_agent_id,
           CASE WHEN c.author_user_id IS NOT NULL THEN u.display_name ELSE 'Agent' END AS author_name
      FROM team_comments c
      LEFT JOIN team_users u ON u.id = c.author_user_id
     WHERE c.workspace_id = $1 AND c.proposal_id = $2
     ORDER BY c.created_at`, [workspaceId, proposalId]);
  return result.rows.map((row: { id: string; proposal_id: string; body: string; created_at: Date; author_user_id: string | null; author_agent_id: string | null; author_name: string | null }) => ({
    id: row.id,
    proposalId: row.proposal_id,
    body: row.body,
    author: { userId: row.author_user_id ?? "", displayName: row.author_name ?? "Former member", agentTokenId: row.author_agent_id },
    createdAt: row.created_at.toISOString(),
  }));
}
