"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { diffLines } from "diff";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/**
 * Proposal editor with per-tab private drafts. Drafts live in
 * sessionStorage (keyed per workspace+prompt+base), never on the server:
 * "saved in this tab", cleared on sign-out, recoverable as a download, and
 * a beforeunload warning while unsaved changes exist. Submission binds the
 * exact base revision; a stale base surfaces the conflict for a rebase.
 */

export interface ProposalDraft {
  content: string;
  rationale: string;
}

export function ProposalEditor(props: {
  workspaceId: string;
  epoch: string;
  membershipGeneration: string;
  promptId: string;
  promptTitle: string;
  baseRevisionId: string;
  baseContent: string;
  supersedesProposalId: string | null;
  conflictHint?: string;
}) {
  const router = useRouter();
  const storageKey = `pb-team-draft:${props.workspaceId}:${props.promptId}:${props.baseRevisionId}`;
  const [draft, setDraft] = useState<ProposalDraft>({ content: "", rationale: "" });
  const [restored, setRestored] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(props.conflictHint ?? null);
  const [conflict, setConflict] = useState<string | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      try {
        setDraft(JSON.parse(saved) as ProposalDraft);
        setRestored(true);
      } catch {
        sessionStorage.removeItem(storageKey);
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [storageKey]);

  function update(patch: Partial<ProposalDraft>) {
    dirty.current = true;
    setDraft((current) => {
      const next = { ...current, ...patch };
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }

  function download() {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `promptbranch-draft-${props.promptId.slice(0, 8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const diff = useMemo(
    () => diffLines(props.baseContent, draft.content || ""),
    [props.baseContent, draft.content],
  );

  async function submit() {
    setPending(true);
    setError(null);
    setConflict(null);
    const result = await teamPost<{ result?: { id: string } }>(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
      commandId: crypto.randomUUID(),
      membershipGeneration: props.membershipGeneration,
      operation: {
        type: "proposal.submit",
        promptId: props.promptId,
        baseRevisionId: props.baseRevisionId,
        content: draft.content,
        rationale: draft.rationale,
        supersedesProposalId: props.supersedesProposalId,
      },
    }, { "x-promptbranch-team-epoch": props.epoch });
    setPending(false);
    const data = result.data as { result?: { id: string }; message?: string; code?: string };
    if (!result.ok || !data.result) {
      if (data.code === "STALE_ENTITY" || data.code === "STALE_BASE") {
        setConflict(data.message ?? "The approved head moved since this base. Rebase onto the new head.");
      } else {
        setError(data.message ?? "Could not submit the proposal");
      }
      return;
    }
    sessionStorage.removeItem(storageKey);
    dirty.current = false;
    router.push(`/team/w/${props.workspaceId}/proposals/${data.result.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Propose a change</h1>
        <p className="mt-1 text-xs text-ink-faint">
          Base: {props.promptTitle} · revision {props.baseRevisionId.slice(0, 8)} — the immutable candidate is created on submit.
        </p>
      </div>

      {restored ? (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-xs text-accent" role="status">
          Draft restored — saved in this tab only.{" "}
          <button type="button" onClick={download} className="underline inline-flex items-center gap-1">
            <DownloadSimple size={12} aria-hidden /> Download a copy
          </button>
        </p>
      ) : null}

      {conflict ? (
        <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {conflict} Reload the prompt page and start a new proposal on the current head to rebase.
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-dim">Candidate content</span>
          <textarea
            value={draft.content}
            onChange={(event) => update({ content: event.target.value })}
            rows={16}
            maxLength={65536}
            required
            className="w-full rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-dim">Diff against base</span>
          <div aria-label="Diff against base" className="code-box max-h-[460px] overflow-y-auto" data-view="rendered">
            <header className="code-box-bar">
              <span className="code-box-dots" aria-hidden>
                <i /> <i /> <i />
              </span>
              <span className="code-box-title">candidate.md</span>
            </header>
            <div className="code-box-pane overflow-x-auto">
              <pre className="diff-view font-mono text-[13px] leading-relaxed">
                {diff.map((part, index) => (
                  <div
                    key={index}
                    className={
                      part.added
                        ? "diff-line bg-diff-add-bg text-diff-add-text"
                        : part.removed
                          ? "diff-line bg-diff-del-bg text-diff-del-text"
                          : "diff-line text-ink-dim"
                    }
                  >
                    {part.value.replace(/\n$/, "")}
                  </div>
                ))}
              </pre>
            </div>
          </div>
        </div>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink-dim">Rationale</span>
        <textarea
          value={draft.rationale}
          onChange={(event) => update({ rationale: event.target.value })}
          rows={3}
          maxLength={8000}
          required
          placeholder="Why this change, and what it improves…"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || draft.content.trim().length === 0 || draft.rationale.trim().length === 0}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-strong active:translate-y-[1px] disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Submit for review"}
        </button>
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-dim hover:bg-hover hover:text-ink"
        >
          <DownloadSimple size={13} aria-hidden /> Download draft
        </button>
      </div>
    </div>
  );
}
