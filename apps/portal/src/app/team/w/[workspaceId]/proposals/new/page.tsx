import { notFound } from "next/navigation";
import { getPromptWithHead } from "@promptbranch/team-server";
import { ProposalEditor } from "@/components/team/proposal-editor";
import { requireWorkspacePage } from "@/lib/team/ssr";

// New-proposal page. The base defaults to the current approved head; a
// stale-base hint appears when arriving from a conflict rebase.

export default async function NewProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ promptId?: string; base?: string; supersedes?: string; stale?: string }>;
}) {
  const { workspaceId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  const query = await searchParams;
  if (!query.promptId) notFound();
  const detail = await getPromptWithHead(service.pool, workspaceId, query.promptId).catch(() => null);
  if (!detail) notFound();
  if (["viewer"].includes(workspace.role)) {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Viewers cannot open proposals.</p>;
  }
  const baseRevisionId = query.base && query.base !== "undefined" ? query.base : detail.prompt.approvedRevisionId ?? "";
  if (!baseRevisionId) notFound();

  return (
    <ProposalEditor
      workspaceId={workspaceId}
      epoch={workspace.serverEpoch}
      membershipGeneration={workspace.membershipGeneration}
      promptId={query.promptId}
      promptTitle={detail.prompt.title}
      baseRevisionId={baseRevisionId}
      baseContent={detail.revision.content}
      supersedesProposalId={query.supersedes ?? null}
      conflictHint={query.stale === "1" ? "The previous proposal was rebased: this draft starts from the current head." : undefined}
    />
  );
}
