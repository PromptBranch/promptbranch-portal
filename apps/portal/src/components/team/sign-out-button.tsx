"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SignOut } from "@phosphor-icons/react/dist/ssr";
import { teamPost } from "@/lib/team/csrf-client";

/** Signs the browser out through the CSRF-protected BFF logout route. */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        // Best effort: local revocation is authoritative server-side.
        await teamPost("/team/auth/logout", {}).catch(() => undefined);
        // Drafts are per-tab private state; leaving the account clears them.
        for (const key of Object.keys(sessionStorage)) {
          if (key.startsWith("pb-team-draft:")) sessionStorage.removeItem(key);
        }
        router.push("/");
        router.refresh();
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
    >
      <SignOut size={13} aria-hidden />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
