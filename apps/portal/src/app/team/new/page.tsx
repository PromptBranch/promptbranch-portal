import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import { NewWorkspaceForm } from "@/components/team/new-workspace-form";
import { requireSignedIn } from "@/lib/team/ssr";

export const metadata: Metadata = {
  title: "New workspace",
  robots: { index: false, follow: false },
};

export default async function NewWorkspacePage() {
  await requireSignedIn();
  return (
    <div className="min-h-screen bg-app text-ink">
      <main className="mx-auto max-w-md px-4 py-16">
        <Link href="/team" className="inline-flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink">
          <ArrowLeft size={13} aria-hidden /> Back to workspaces
        </Link>
        <h1 className="mt-4 text-xl font-semibold">Create a workspace</h1>
        <div className="mt-6 rounded-xl border border-line bg-panel p-5">
          <NewWorkspaceForm />
        </div>
      </main>
    </div>
  );
}
