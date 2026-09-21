"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { teamPost } from "@/lib/team/csrf-client";

/** Creates a workspace (idempotent per commandId); lands in its library. */
export function NewWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await teamPost<{ workspace?: { id: string } }>("/api/team/v1/workspaces", {
      commandId: crypto.randomUUID(),
      name,
    });
    setPending(false);
    const workspace = (result.data as { workspace?: { id: string } }).workspace;
    if (!result.ok || !workspace) {
      setError((result.data as { message?: string })?.message ?? "Could not create the workspace");
      return;
    }
    router.push(`/team/w/${workspace.id}/library`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-medium text-ink-dim" htmlFor="workspace-name">
        Workspace name
      </label>
      <input
        id="workspace-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        maxLength={200}
        placeholder="e.g. Platform team"
        className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || name.trim().length === 0}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-strong active:translate-y-[1px] disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
