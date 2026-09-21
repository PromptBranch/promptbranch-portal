import Link from "next/link";
import { DeleteWorkspaceForm, RenameWorkspaceForm } from "@/components/team/settings-actions";
import { requireWorkspacePage } from "@/lib/team/ssr";

// General settings: rename + fresh-login/confirm-name deletion. Agents and
// audit live on sibling pages; all owner-gated.

export default async function GeneralSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspacePage(workspaceId);
  if (workspace.role !== "owner") {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Only the workspace owner can change workspace settings.</p>;
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold tracking-tight text-ink">General</h1>
        <div className="mt-4 max-w-xl">
          <RenameWorkspaceForm epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration} workspaceId={workspaceId} currentName={workspace.name} entityVersion={workspace.entityVersion} />
        </div>
        <div className="mt-6 flex gap-3 text-xs">
          <Link href={`/team/w/${workspaceId}/settings/agents`} className="rounded-lg border border-line px-3 py-2 text-ink-dim hover:bg-hover hover:text-ink">
            Agent tokens
          </Link>
          <Link href={`/team/w/${workspaceId}/settings/audit`} className="rounded-lg border border-line px-3 py-2 text-ink-dim hover:bg-hover hover:text-ink">
            Audit trail
          </Link>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-danger-soft/30 p-5">
        <h2 className="text-sm font-semibold text-danger">Danger zone</h2>
        <div className="mt-3 max-w-xl">
          <DeleteWorkspaceForm epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration} workspaceId={workspaceId} name={workspace.name} entityVersion={workspace.entityVersion} />
        </div>
      </section>
    </div>
  );
}
