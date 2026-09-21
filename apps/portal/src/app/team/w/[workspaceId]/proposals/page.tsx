import Link from "next/link";
import { listProposals, type ProposalStatus } from "@promptbranch/team-server";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Proposals list — contributor+ surface (viewers are told, not shown).

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent-soft text-accent",
  approved: "text-success border border-line",
  rejected: "text-danger border border-line",
  withdrawn: "text-ink-faint border border-line",
  superseded: "text-ink-faint border border-line",
};

const TABS: Array<{ key: string; label: string }> = [
  { key: "open", label: "Open" },
  { key: "", label: "All" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export default async function ProposalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ status?: string; promptId?: string }>;
}) {
  const { workspaceId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  if (["viewer"].includes(workspace.role)) {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Viewers see the approved library only.</p>;
  }
  const query = await searchParams;
  const status = query.status && ["open", "approved", "rejected", "withdrawn", "superseded"].includes(query.status)
    ? (query.status as ProposalStatus)
    : undefined;
  const result = await listProposals(service.pool, workspaceId, { status, promptId: query.promptId });

  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Proposals</h1>
      <div className="mt-3 flex gap-1.5 text-xs">
        {TABS.map((tab) => (
          <Link
            key={tab.key || "all"}
            href={`/team/w/${workspaceId}/proposals${tab.key ? `?status=${tab.key}` : ""}`}
            className={`rounded-full px-2.5 py-1 transition-colors ${
              (query.status ?? "open") === tab.key ? "bg-accent-soft text-accent" : "bg-raised text-ink-dim hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {result.items.length === 0 ? (
        <p className="mt-6 rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">
          {status === "open" || !status ? "No open proposals. Start one from any approved prompt." : `No ${status} proposals.`}
        </p>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {result.items.map((proposal) => (
            <li key={proposal.id}>
              <Link
                href={`/team/w/${workspaceId}/proposals/${proposal.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{proposal.rationale}</span>
                  <span className="block text-xs text-ink-faint">
                    by {proposal.author.displayName}
                    {proposal.author.agentTokenId ? " (agent)" : ""} · {new Date(proposal.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[proposal.status] ?? "border border-line text-ink-faint"}`}>
                  {proposal.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
