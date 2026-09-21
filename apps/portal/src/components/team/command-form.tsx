"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/**
 * Shared client form for cookie-authenticated team mutations. Every browser
 * action goes through the same JSON API + CSRF/origin enforcement the
 * contract mandates — the UI never talks to SQL or a privileged helper.
 */

export function CommandForm(props: {
  action: string;
  /** Envelope minus commandId (generated per submit for retries). */
  buildEnvelope: (commandId: string) => unknown;
  epoch: string;
  onDone?: (data: Record<string, unknown>) => void;
  children: (state: { pending: boolean; error: string | null }) => ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const commandId = crypto.randomUUID();
    const envelope = props.buildEnvelope(commandId);
    const result = await teamPost<Record<string, unknown>>(props.action, envelope, {
      "x-promptbranch-team-epoch": props.epoch,
    });
    setPending(false);
    if (!result.ok) {
      setError((result.data as TeamApiError)?.message ?? "Something went wrong");
      return;
    }
    const data = result.data as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      props.onDone?.(data);
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className={props.className}>
      {props.children({ pending, error })}
      {error ? (
        <p role="alert" className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
