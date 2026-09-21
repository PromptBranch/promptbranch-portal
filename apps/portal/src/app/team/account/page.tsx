import type { Metadata } from "next";
import { getTeamService } from "@/lib/team/service";
import { getTeamPageSession } from "@/lib/team/ssr";
import { SessionControls, RevokeSessionButton } from "@/components/team/account-actions";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await getTeamPageSession();
  if (!session) redirect("/team/auth/login");
  const service = getTeamService();
  const sessions = await session.service.sessions.listUserSessions(session.auth.userId);
  void service;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-lg font-semibold">Your account</h1>
      <section className="mt-6">
        <h2 className="text-sm font-semibold">Sign-in sessions</h2>
        <ul className="mt-3 space-y-1.5">
          {sessions.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
              <span className="min-w-0 text-ink-dim">
                {entry.clientId} · last seen {new Date(entry.lastSeenAt).toLocaleString()}
                {entry.revokedAt ? <span className="ml-2 text-danger">revoked</span> : null}
              </span>
              {entry.revokedAt ? null : <RevokeSessionButton sessionId={entry.id} />}
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-8">
        <SessionControls />
      </section>
    </div>
  );
}
