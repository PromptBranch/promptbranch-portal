import { listAudit } from "@promptbranch/team-server";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Metadata-only audit view: actor/time/resource — no content, no secrets
// (the table has none by construction).

export default async function AuditSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  if (workspace.role !== "owner") {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Only the workspace owner can read the audit trail.</p>;
  }
  const audit = await listAudit(service.pool, workspaceId, { limit: 100 });

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Audit</h1>
      <p className="mt-1 text-xs text-ink-faint">Actor, time and resource only — never prompt content or credentials.</p>
      {audit.length === 0 ? (
        <p className="mt-4 rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">No audit entries yet.</p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {audit.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-line bg-panel px-3.5 py-2.5 font-mono text-[11px] text-ink-dim">
              <span className="text-ink">{entry.action}</span>
              <span className="text-ink-faint">{entry.resourceType}:{entry.resourceId.slice(0, 8)}</span>
              <span className="ml-auto text-ink-faint">{new Date(entry.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
