import { CopyButton } from "@/components/copy-actions";
import { MarkdownHtml } from "@/components/markdown";
import { ViewToggle } from "@/components/view-toggle";

/**
 * Editor-style container for the shared prompt. Both views are computed on
 * the server (page.tsx) and injected here; the client-side ViewToggle only
 * flips which pane is visible.
 */
export function CodeBox(props: { contentHtml: string; sourceHtml: string; markdown: string; className?: string }) {
  return (
    <section
      className={`code-box ${props.className ?? ""}`}
      data-view="rendered"
      aria-label="Prompt content"
    >
      <header className="code-box-bar">
        <span className="code-box-dots" aria-hidden>
          <i /> <i /> <i />
        </span>
        <span className="code-box-title">prompt.md</span>
        <div className="flex items-center gap-1.5">
          <ViewToggle />
          <CopyButton label="Copy" text={props.markdown} />
        </div>
      </header>
      <div data-pane="rendered" className="code-box-pane">
        <MarkdownHtml html={props.contentHtml} />
      </div>
      <div data-pane="source" className="code-box-pane">
        {/* Shiki HTML generated server-side from the markdown source —
            never user HTML (see lib/highlight.ts). */}
        <div className="source-view" dangerouslySetInnerHTML={{ __html: props.sourceHtml }} />
      </div>
    </section>
  );
}
