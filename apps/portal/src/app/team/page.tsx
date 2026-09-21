import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { ThemeToggle } from "@/components/theme-toggle";
import { NewWorkspaceForm } from "@/components/team/new-workspace-form";
import { listOwnWorkspaces, requireSignedIn } from "@/lib/team/ssr";

export const metadata: Metadata = {
  title: "Your workspaces",
  robots: { index: false, follow: false },
};

export default async function WorkspacePickerPage() {
  const session = await requireSignedIn();
  const workspaces = await listOwnWorkspaces(session);

  return (
    <div className="min-h-screen bg-app text-ink">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-4 px-4">
          <Link href="/" className="text-[15px] font-semibold tracking-tight">
            PromptBranch
          </Link>
          <span className="text-ink-faint">/</span>
          <span className="text-sm text-ink-dim">Team workspaces</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-xl font-semibold">Your workspaces</h1>
        <ul className="mt-6 space-y-2.5">
          {workspaces.length === 0 ? (
            <li className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">
              You haven&apos;t joined a workspace yet. Create one below, or accept an invitation from your email link.
            </li>
          ) : (
            workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/team/w/${workspace.id}/library`}
                  className="flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{workspace.name}</span>
                    <span className="block text-xs text-ink-faint">{workspace.role}</span>
                  </span>
                  <ArrowRight size={16} aria-hidden className="flex-none text-ink-faint" />
                </Link>
              </li>
            ))
          )}
        </ul>
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">New workspace</h2>
          <p className="mt-1 text-xs text-ink-faint">
            You become the sole owner; invite teammates from the Members settings.
          </p>
          <div className="mt-4 max-w-md rounded-xl border border-line bg-panel p-5">
            <NewWorkspaceForm />
          </div>
        </section>
      </main>
    </div>
  );
}

// Signed-out visitors are redirected to the sign-in flow by requireSignedIn.
export const dynamic = "force-dynamic";
