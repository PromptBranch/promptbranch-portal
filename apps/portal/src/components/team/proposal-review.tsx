"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/**
 * Reviewer actions on a proposal: approve binds the exact immutable
 * candidate id + hash and the expected approved head; any drift (stale
 * base, moved head, closed proposal) surfaces as an explicit conflict with
 * a rebase path instead of a silent failure.
 */

export function ReviewActions(props: {
  workspaceId: string;
  proposalId: string;
  epoch: string;
  membershipGeneration: string;
  candidateRevisionId: string;
  candidateContentHash: string;
  expectedApprovedRevisionId: string;
  expectedEntityVersion: number;
  selfReview: boolean;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  async function review(decision: "approve" | "reject") {
    setPending(decision);
    setError(null);
    setConflict(null);
    const result = await teamPost(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
      commandId: crypto.randomUUID(),
      membershipGeneration: props.membershipGeneration,
      operation: {
        type: "proposal.review",
        proposalId: props.proposalId,
        expectedEntityVersion: props.expectedEntityVersion,
        candidateRevisionId: props.candidateRevisionId,
        candidateContentHash: props.candidateContentHash,
        expectedApprovedRevisionId: props.expectedApprovedRevisionId,
        decision,
        comment,
      },
    }, { "x-promptbranch-team-epoch": props.epoch });
    setPending(null);
    const data = result.data as TeamApiError;
    if (!result.ok) {
      if (data.code === "STALE_BASE" || data.code === "STALE_ENTITY") {
        setConflict(data.message ?? "The proposal or approved head changed; reload to see the current state.");
      } else {
        setError(data.message ?? "Review failed");
      }
      return;
    }
    router.refresh();
  }

  if (props.selfReview) {
    return (
      <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent">
        You authored this proposal (or it came from your agent). A different maintainer must review it.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {conflict ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {conflict}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={2}
        maxLength={8000}
        placeholder="Review comment (optional)…"
        aria-label="Review comment"
        className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => review("approve")}
          className="rounded-lg bg-success px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => review("reject")}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      <p className="font-mono text-[10px] text-ink-faint">
        binds candidate {props.candidateRevisionId.slice(0, 8)} · sha-256 {props.candidateContentHash.slice(0, 12)}…
      </p>
    </div>
  );
}

/** Author-side withdrawal (own human or own agent proposal only). */
export function WithdrawButton(props: {
  workspaceId: string;
  proposalId: string;
  membershipGeneration: string;
  epoch: string;
  expectedEntityVersion: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await teamPost(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
            commandId: crypto.randomUUID(),
            membershipGeneration: props.membershipGeneration,
            operation: { type: "proposal.withdraw", proposalId: props.proposalId, expectedEntityVersion: props.expectedEntityVersion },
          }, { "x-promptbranch-team-epoch": props.epoch });
          setPending(false);
          if (!result.ok) {
            setError((result.data as TeamApiError)?.message ?? "Withdraw failed");
            return;
          }
          router.refresh();
        }}
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
      >
        {pending ? "Withdrawing…" : "Withdraw proposal"}
      </button>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Contributor comment box (agents use the API; the browser is human-only). */
export function CommentBox(props: { workspaceId: string; proposalId: string; membershipGeneration: string; epoch: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={2}
        maxLength={8000}
        placeholder="Add to the discussion…"
        aria-label="Add a comment"
        className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending || body.trim().length === 0}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await teamPost(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
            commandId: crypto.randomUUID(),
            membershipGeneration: props.membershipGeneration,
            operation: { type: "comment.add", proposalId: props.proposalId, body },
          }, { "x-promptbranch-team-epoch": props.epoch });
          setPending(false);
          if (!result.ok) {
            setError((result.data as TeamApiError)?.message ?? "Could not post the comment");
            return;
          }
          setBody("");
          router.refresh();
        }}
        className="mt-2 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-strong disabled:opacity-50"
      >
        {pending ? "Posting…" : "Comment"}
      </button>
    </div>
  );
}
