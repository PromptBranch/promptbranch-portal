import Link from "next/link";
import { notFound } from "next/navigation";
import { diffLines } from "diff";
import { getProposalDetail, getPromptWithHead, listComments } from "@promptbranch/team-server";
import { ReviewActions, WithdrawButton, CommentBox } from "@/components/team/proposal-review";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Proposal detail — the ONLY surface where candidate content exists, and
// only for contributor+ members. Shows the immutable candidate hash and
// version, freshness against the current head, and distinct-reviewer
// requirements; rebase is a NEW proposal (supersedes).

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent-soft text-accent",
  approved: "text-success border border-line",
  rejected: "text-danger border border-line",
  withdrawn: "text-ink-faint border border-line",
  superseded: "text-ink-faint border border-line",
};

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; proposalId: string }>;
}) {
  const { workspaceId, proposalId } = await params;
  const { service, workspace, auth } = await requireWorkspacePage(workspaceId);
  if (["viewer"].includes(workspace.role)) {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Viewers cannot see proposals.</p>;
  }
  const detail = await getProposalDetail(service.pool, workspaceId, proposalId).catch(() => null);
  if (!detail) notFound();
  const comments = await listComments(service.pool, workspaceId, proposalId);
  const prompt = await getPromptWithHead(service.pool, workspaceId, detail.proposal.promptId).catch(() => null);
  const currentHead = prompt?.prompt.approvedRevisionId ?? null;
  const isStale = detail.proposal.status === "open" && currentHead !== detail.proposal.baseRevisionId;
  const isOwn =
    (auth.userId === detail.proposal.author.userId && detail.proposal.author.agentTokenId === null) || false;
  const selfReview = detail.proposal.author.userId === auth.userId;
  const canReview = ["owner", "maintainer"].includes(workspace.role) && detail.proposal.status === "open";
  const canRebase = detail.proposal.status === "open" && isOwn && isStale;
  const diff = diffLines(detail.base.content, detail.candidate.content);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            Proposal
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[detail.proposal.status] ?? "border border-line text-ink-faint"}`}>
              {detail.proposal.status}
            </span>
            {isStale ? <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-medium uppercase text-danger">stale base</span> : null}
          </h1>
          <p className="mt-1 text-xs text-ink-faint">
            by {detail.proposal.author.displayName}
            {detail.proposal.author.agentTokenId ? " (agent)" : ""} · for{" "}
            <Link href={`/team/w/${workspaceId}/prompts/${detail.proposal.promptId}`} className="underline hover:text-ink-dim">
              {prompt?.prompt.title ?? detail.proposal.promptId.slice(0, 8)}
            </Link>
          </p>
        </div>
        {detail.proposal.status === "open" && isOwn ? (
          <WithdrawButton
            epoch={workspace.serverEpoch}
            workspaceId={workspaceId}
            proposalId={proposalId}
            membershipGeneration={workspace.membershipGeneration}
            expectedEntityVersion={detail.proposal.entityVersion}
          />
        ) : null}
      </div>

      <section className="rounded-xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold">Rationale</h2>
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-dim">{detail.proposal.rationale}</p>
        <p className="mt-3 font-mono text-[10px] text-ink-faint">
          candidate {detail.candidate.id.slice(0, 8)} · sha-256 {detail.candidate.contentHash.slice(0, 16)}… · base {detail.proposal.baseRevisionId.slice(0, 8)}
        </p>
      </section>

      <section aria-label="Candidate diff">
        <h2 className="mb-2 text-sm font-semibold">Change against base</h2>
        <div className="overflow-hidden rounded-xl border border-line bg-panel font-mono text-[12px] leading-relaxed">
          {diff.map((part, index) => (
            <pre
              key={index}
              className={`whitespace-pre-wrap px-4 py-1 ${
                part.added ? "bg-diff-add-bg text-diff-add-text" : part.removed ? "bg-diff-del-bg text-diff-del-text" : "text-ink-dim"
              }`}
            >
              {part.value || "\u00a0"}
            </pre>
          ))}
        </div>
      </section>

      {canRebase ? (
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="text-sm font-semibold">Rebase onto the current head</h2>
          <p className="mt-1 text-xs text-ink-dim">
            The approved head moved since this proposal was based on it. Rebase closes this proposal and opens a new one on the current head.
          </p>
          <Link
            href={`/team/w/${workspaceId}/proposals/new?promptId=${detail.proposal.promptId}&base=${currentHead}&supersedes=${proposalId}&stale=1`}
            className="mt-3 inline-flex rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-strong"
          >
            Rebase proposal
          </Link>
        </section>
      ) : null}

      {canReview ? (
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-2.5 text-sm font-semibold">Review</h2>
          <ReviewActions
            workspaceId={workspaceId}
            proposalId={proposalId}
            epoch={workspace.serverEpoch}
            membershipGeneration={workspace.membershipGeneration}
            candidateRevisionId={detail.proposal.candidateRevisionId}
            candidateContentHash={detail.candidate.contentHash}
            expectedApprovedRevisionId={detail.proposal.baseRevisionId}
            expectedEntityVersion={detail.proposal.entityVersion}
            selfReview={selfReview}
          />
        </section>
      ) : null}

      {detail.reviews.length > 0 ? (
        <section aria-label="Reviews">
          <h2 className="mb-2 text-sm font-semibold">Decision</h2>
          <ul className="space-y-1.5">
            {detail.reviews.map((review) => (
              <li key={review.id} className="rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
                <span className={review.decision === "approve" ? "font-medium text-success" : "font-medium text-danger"}>
                  {review.decision}
                </span>{" "}
                by {review.reviewer.displayName}
                {review.comment ? <span className="mt-1 block text-ink-dim">{review.comment}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Discussion">
        <h2 className="mb-2 text-sm font-semibold">Discussion</h2>
        {comments.length === 0 ? (
          <p className="text-xs text-ink-faint">No comments yet.</p>
        ) : (
          <ul className="mb-3 space-y-1.5">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
                <span className="font-medium text-ink-dim">
                  {comment.author.displayName}
                  {comment.author.agentTokenId ? " (agent)" : ""}
                </span>
                <span className="ml-2 text-ink-faint">{new Date(comment.createdAt).toLocaleString()}</span>
                <p className="mt-1 whitespace-pre-wrap text-ink-dim">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
        {["owner", "maintainer", "contributor"].includes(workspace.role) && detail.proposal.status !== "superseded" ? (
          <CommentBox epoch={workspace.serverEpoch} workspaceId={workspaceId} proposalId={proposalId} membershipGeneration={workspace.membershipGeneration} />
        ) : null}
      </section>
    </div>
  );
}
