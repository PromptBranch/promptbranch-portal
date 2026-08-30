import type { SnapshotPayload } from "@promptbranch/share";
import { SnapshotActions } from "@/components/copy-actions";
import { CodeBox } from "@/components/code-box";
import { Topbar } from "@/components/topbar";
import { VersionHistory } from "@/components/version-history";

/**
 * Shared-prompt viewer shell. Sync by design: page.tsx awaits the async
 * markdown/highlight work and hands the HTML in, keeping this component
 * trivially testable and free of client-side rendering.
 */
export function SnapshotView(props: {
  id: string;
  url: string;
  snapshot: SnapshotPayload;
  publishedAt: string;
  contentHtml: string;
  sourceHtml: string;
}) {
  const { snapshot, url } = props;
  const published = new Date(props.publishedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <div className="min-h-screen">
      <Topbar />
      <main className="mx-auto w-full max-w-3xl px-6 pb-24">
        <div className="pt-12 sm:pt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            Shared prompt
          </p>
          <h1 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            {snapshot.title}
          </h1>
          {snapshot.description ? (
            <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed [text-wrap:pretty] text-ink-dim">
              {snapshot.description}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-faint">
            {snapshot.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-line bg-panel px-2.5 py-1 font-medium text-ink-dim"
              >
                {tag}
              </span>
            ))}
            {snapshot.tags.length > 0 ? <span aria-hidden>·</span> : null}
            <span className="tabular-nums">Published {published}</span>
          </div>
          <SnapshotActions
            className="mt-7"
            importCommand={`promptbranch import ${url}`}
            deepLink={`promptbranch://import?url=${encodeURIComponent(url)}`}
          />
        </div>
        <CodeBox
          className="mt-10"
          contentHtml={props.contentHtml}
          sourceHtml={props.sourceHtml}
          markdown={snapshot.content}
        />
        {snapshot.history && snapshot.history.length > 0 ? (
          <section className="mt-16">
            <h2 className="text-lg font-semibold tracking-tight text-ink">Version history</h2>
            <p className="mt-1 text-sm text-ink-dim">Compare any two versions of this prompt.</p>
            <VersionHistory history={snapshot.history} current={snapshot.content} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
