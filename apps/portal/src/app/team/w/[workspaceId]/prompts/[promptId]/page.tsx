import Link from "next/link";
import { notFound } from "next/navigation";
import { ClockCounterClockwise, NotePencil } from "@phosphor-icons/react/dist/ssr";
import { getPromptWithHead, listPublishedRevisions } from "@promptbranch/team-server";
import { CopyButton } from "@/components/copy-actions";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Approved prompt detail: the CURRENT head revision's exact content, a
// copy button that copies it verbatim, published history, and a deep link
// carrying origin/workspace/prompt ids only — never a token or candidate
// content. React escapes all titles and content by construction.

export default async function PromptDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; promptId: string }>;
}) {
  const { workspaceId, promptId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  const detail = await getPromptWithHead(service.pool, workspaceId, promptId).catch(() => null);
  if (!detail) notFound();
  const history = await listPublishedRevisions(service.pool, workspaceId, promptId, { limit: 10 });
  const canPropose = ["owner", "maintainer", "contributor"].includes(workspace.role);

  const deepLink = `promptbranch://team/open?origin=${encodeURIComponent(process.env.TEAM_PUBLIC_ORIGIN ?? "")}&workspace=${workspaceId}&prompt=${promptId}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{detail.prompt.title}</h1>
          {detail.prompt.description ? <p className="mt-1 max-w-2xl text-sm text-ink-dim">{detail.prompt.description}</p> : null}
          <p className="mt-2 text-xs text-ink-faint">
            Approved revision by {detail.revision.author.displayName} · {new Date(detail.revision.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <CopyButton label="Copy prompt" text={detail.revision.content} />
          <a
            href={deepLink}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Open in PromptBranch
          </a>
        </div>
      </div>

      <section aria-label="Approved content" className="mt-6">
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-line bg-panel p-4 font-mono text-[13px] leading-relaxed text-ink">
          {detail.revision.content}
        </pre>
        <p className="mt-2 font-mono text-[10px] text-ink-faint">sha-256 {detail.revision.contentHash}</p>
      </section>

      <section aria-label="Published history" className="mt-8">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <ClockCounterClockwise size={14} aria-hidden /> Published history
        </h2>
        <ul className="mt-3 space-y-1.5">
          {history.items.map((revision) => (
            <li key={revision.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
              <span className="min-w-0 truncate text-ink-dim">
                {revision.id === detail.prompt.approvedRevisionId ? <span className="mr-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium uppercase text-accent">current</span> : null}
                {revision.changeNote || "revision"} — {revision.author.displayName}
              </span>
              <CopyButton label="Copy" text={revision.content} />
            </li>
          ))}
        </ul>
      </section>

      {canPropose ? (
        <section className="mt-8 rounded-xl border border-line bg-panel p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <NotePencil size={14} aria-hidden /> Propose a change
          </h2>
          <p className="mt-1 text-xs text-ink-dim">
            Changes go through review: draft privately in this tab, then submit for a maintainer&apos;s approval.
          </p>
          <Link
            href={`/team/w/${workspaceId}/proposals/new?promptId=${promptId}&base=${detail.prompt.approvedRevisionId ?? ""}`}
            className="mt-3 inline-flex rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
          >
            New proposal
          </Link>
        </section>
      ) : null}
    </div>
  );
}
