"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { teamDelete, teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/** Account session controls: revoke one device or everything. */
export function SessionControls() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revokeAll() {
    setPending(true);
    setError(null);
    const result = await teamPost("/api/team/v1/sessions/revoke-all", {});
    setPending(false);
    if (!result.ok) {
      setError((result.data as TeamApiError)?.message ?? "Could not revoke sessions");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={revokeAll}
        className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
      >
        {pending ? "Revoking…" : "Sign out everywhere"}
      </button>
      <p className="mt-1.5 text-xs text-ink-faint">Revokes every sign-in session (agent tokens are unaffected until their owner removes them).</p>
    </div>
  );
}

export function RevokeSessionButton(props: { sessionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await teamDelete(`/api/team/v1/sessions/${props.sessionId}`).catch(() => undefined);
        setPending(false);
        router.refresh();
      }}
      className="rounded-md border border-line px-2 py-1 text-xs text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}

/** Invitation acceptance: the GET page never consumes; only this POST does. */
export function AcceptInvitationButton(props: { token: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; id: string } | null>(null);

  if (done) {
    return (
      <div>
        <p className="text-sm text-success" role="status">
          Joined {done.name}.
        </p>
        <button
          type="button"
          onClick={() => router.push(`/team/w/${done.id}/library`)}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong"
        >
          Open workspace
        </button>
      </div>
    );
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending || props.disabled}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await teamPost<{ workspace?: { id: string; name: string } }>("/api/team/v1/invitations/accept", {
            commandId: crypto.randomUUID(),
            token: props.token,
          });
          setPending(false);
          const workspace = (result.data as { workspace?: { id: string; name: string } }).workspace;
          if (!result.ok || !workspace) {
            setError((result.data as TeamApiError)?.message ?? "This invitation is no longer usable");
            return;
          }
          setDone({ name: workspace.name, id: workspace.id });
          router.refresh();
        }}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong active:translate-y-[1px] disabled:opacity-50"
      >
        {pending ? "Accepting…" : "Accept invitation"}
      </button>
    </div>
  );
}
