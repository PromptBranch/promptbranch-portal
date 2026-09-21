import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInvitationButton } from "@/components/team/account-actions";
import { getTeamPageSession } from "@/lib/team/ssr";

export const metadata: Metadata = {
  title: "Accept invitation",
  robots: { index: false, follow: false }, // token-bearing URL: unlisted by design
};

// The page only PREVIEWS the invitation — email scanners following the link
// consume nothing. Acceptance is the explicit authenticated POST below.

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const session = await getTeamPageSession();

  if (!token) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Invitation</h1>
        <p className="mt-2 text-sm text-ink-dim">This invitation link is incomplete. Use the exact link from your email.</p>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">You&apos;re invited to a PromptBranch workspace</h1>
        <p className="mt-2 text-sm text-ink-dim">Sign in with the email address the invitation was sent to, then return here to accept.</p>
        <Link href={`/team/auth/login?next=${encodeURIComponent(`/team/invitations/accept?token=${token}`)}`} className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">
          Sign in to accept
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Accept invitation</h1>
      <p className="mt-2 text-sm text-ink-dim">
        You are signed in as <span className="font-medium text-ink">{session.auth.webSession?.email ?? "your verified address"}</span>.
        The invitation must match this address exactly.
      </p>
      <div className="mt-5">
        <AcceptInvitationButton token={token} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md px-4 py-16">{children}</div>;
}
