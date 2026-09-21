import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";
import { getPromptWithHead, listPublishedRevisions } from "@promptbranch/team-server";
import { CodeBox } from "@/components/code-box";
import { VersionHistory } from "@/components/version-history";
import { requireWorkspacePage } from "@/lib/team/ssr";
import { highlightSource } from "@/lib/highlight";
import { markdownToHtml } from "@/lib/markdown-to-html";

// Approved prompt detail — the SAME viewer concept as the shared-snapshot
// page: mono eyebrow, tag pills, actions row, and the editor-style CodeBox
// (Rendered/Source toggle + copy) fed by the shared sanitize-then-highlight
// pipeline. Team surfaces reuse the portal's design language; only the
// collaboration affordances (history compare, propose-change) are new.

export default async function PromptDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; promptId: string }>;
}) {
  const { workspaceId, promptId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  const detail = await getPromptWithHead(service.pool, workspaceId, promptId).catch(() => null);
  if (!detail) notFound();
  const history = await listPublishedRevisions(service.pool, workspaceId, promptId, { limit: 100 });
  const canPropose = ["owner", "maintainer", "contributor"].includes(workspace.role);
  // Older-than-current revisions available for comparison (a lone seed has none).
  const priorRevisions = history.items.filter((revision) => revision.id !== detail.prompt.approvedRevisionId);

  // Same async rendering contract as the snapshot viewer: both views are
  // computed server-side; CodeBox's toggle only flips visibility.
  const [contentHtml, sourceHtml] = await Promise.all([
    markdownToHtml(detail.revision.content),
    highlightSource(detail.revision.content),
  ]);

  const deepLink = `promptbranch://team/open?origin=${encodeURIComponent(process.env.TEAM_PUBLIC_ORIGIN ?? "")}&workspace=${workspaceId}&prompt=${promptId}`;
  const created = new Date(detail.revision.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div>
      <div className="pt-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">Approved prompt</p>
        <h1 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-ink">
          {detail.prompt.title}
        </h1>
        {detail.prompt.description ? (
          <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed [text-wrap:pretty] text-ink-dim">
            {detail.prompt.description}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-faint">
          {detail.prompt.archivedAt ? (
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
              archived
            </span>
          ) : null}
          <span className="tabular-nums">
            Approved revision by {detail.revision.author.displayName} · {created}
          </span>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href={deepLink}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-strong active:translate-y-[1px]"
          >
            Open in PromptBranch
            <ArrowUpRight size={15} aria-hidden />
          </a>
          {canPropose ? (
            <Link
              href={`/team/w/${workspaceId}/proposals/new?promptId=${promptId}&base=${detail.prompt.approvedRevisionId ?? ""}`}
              className="rounded-lg border border-line px-3.5 py-2 font-medium text-ink transition-colors hover:bg-hover active:translate-y-[1px]"
            >
              Propose a change
            </Link>
          ) : null}
        </div>
      </div>

      <CodeBox className="mt-10" contentHtml={contentHtml} sourceHtml={sourceHtml} markdown={detail.revision.content} />
      <p className="mt-2 font-mono text-[10px] text-ink-faint">sha-256 {detail.revision.contentHash}</p>

      {priorRevisions.length > 0 ? (
        <section className="mt-16">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Published history</h2>
          <p className="mt-1 text-sm text-ink-dim">Compare any two published revisions of this prompt.</p>
          <VersionHistory
            history={priorRevisions
              .slice()
              .reverse()
              .map((revision, index) => ({ version: index + 1, content: revision.content, changeNote: revision.changeNote }))}
            current={detail.revision.content}
          />
        </section>
      ) : null}
    </div>
  );
}
