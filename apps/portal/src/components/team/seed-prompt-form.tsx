"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/** Maintainer "seed" — the only path that creates a prompt + its first approved revision directly. */
export function SeedPromptForm(props: { workspaceId: string; membershipGeneration: string; epoch: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
      >
        Seed a prompt
      </button>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await teamPost(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
          commandId: crypto.randomUUID(),
          membershipGeneration: props.membershipGeneration,
          operation: { type: "prompt.create", title, description: "", content, tagIds: [], collectionIds: [], changeNote: "initial seed" },
        }, { "x-promptbranch-team-epoch": props.epoch });
        setPending(false);
        if (!result.ok) {
          setError((result.data as TeamApiError)?.message ?? "Could not seed the prompt");
          return;
        }
        setOpen(false);
        setTitle("");
        setContent("");
        router.refresh();
      }}
    >
      <input
        required
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Prompt title"
        aria-label="Prompt title"
        maxLength={200}
        className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <textarea
        required
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={8}
        maxLength={65536}
        placeholder="The prompt's approved starting content…"
        aria-label="Prompt content"
        className="w-full rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-strong active:translate-y-[1px] disabled:opacity-50">
          {pending ? "Seeding…" : "Seed prompt"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-3 py-2 text-xs text-ink-dim hover:bg-hover">
          Cancel
        </button>
      </div>
    </form>
  );
}
