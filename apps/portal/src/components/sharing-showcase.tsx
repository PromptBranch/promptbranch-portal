import Link from "next/link";
import { ArrowUpRight, Code, FileText } from "@phosphor-icons/react/dist/ssr";
import { CopyButton } from "@/components/copy-actions";
import { LiveEmbed } from "@/components/live-embed";
import { DEMO_MARKDOWN_PATH, DEMO_SNAPSHOT_ID } from "@/lib/demo-prompt";
import { buildEmbedSnippet } from "@/lib/embed-snippet";
import { highlightSource } from "@/lib/highlight";

function SnippetWindow({ title, code, html }: { title: string; code: string; html: string }) {
  return (
    <section className="code-box showcase-code" aria-label={`${title} code example`}>
      <div className="code-box-bar">
        <span className="code-box-dots" aria-hidden><i /><i /><i /></span>
        <span className="code-box-title">{title}</span>
        <CopyButton label="Copy code" text={code} />
      </div>
      {/* Only Shiki-generated HTML from our own example snippets reaches this box. */}
      <div className="source-view code-box-pane" tabIndex={0} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="flex items-center justify-between border-t border-line px-4 py-2 font-mono text-[10px] text-ink-faint">
        <span>HTML</span><span>Ready to paste</span>
      </div>
    </section>
  );
}

export async function SharingShowcase({ baseUrl }: { baseUrl: string }) {
  const origin = new URL(baseUrl).origin;
  const snapshotUrl = `${origin}/p/${DEMO_SNAPSHOT_ID}`;
  const markdownUrl = `${origin}${DEMO_MARKDOWN_PATH}`;
  const deepLink = `promptbranch://import-markdown?url=${encodeURIComponent(markdownUrl)}`;
  const embedCode = buildEmbedSnippet(snapshotUrl)
    .replace(" data-promptbranch-embed=", "\n  data-promptbranch-embed=")
    .replace("></div>", "\n></div>")
    .replace("<script defer src=", "<script defer\n  src=")
    .replace("></script>", "\n></script>");
  const buttonCode = `<a\n  href="${deepLink}"\n  style="display:inline-flex;align-items:center;gap:8px;\n         padding:12px 18px;border-radius:8px;\n         background:#315ee8;color:#fff;\n         font:600 14px system-ui;text-decoration:none"\n>\n  Open in PromptBranch <span aria-hidden="true">↗</span>\n</a>`;
  const [embedHtml, buttonHtml] = await Promise.all([
    highlightSource(embedCode, "html"), highlightSource(buttonCode, "html"),
  ]);

  return (
    <section className="border-t border-line" aria-labelledby="sharing-examples-heading">
      <div className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">Made to travel</p>
            <h2 id="sharing-examples-heading" className="mt-3 text-2xl font-semibold tracking-tight text-ink md:text-3xl">Put your prompts on any website</h2>
            <p className="mt-3 max-w-2xl leading-relaxed text-ink-dim">A little HTML. Your prompt, right where people need it.</p>
          </div>
          <Link href="/docs/sharing/link-sharing-and-portal#embed-a-shared-prompt-on-a-website" className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-strong">
            Read the guide <ArrowUpRight size={15} aria-hidden />
          </Link>
        </div>

        <article>
          <div className="mb-5 flex items-start gap-3">
            <Code size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div>
              <h3 className="font-semibold text-ink">Embed a prompt</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-dim">Give readers the full prompt, with rendered Markdown, source, and one-click copy.</p>
            </div>
          </div>
          <div className="grid min-w-0 items-start gap-6 md:grid-cols-2 lg:gap-8">
            <div className="min-w-0">
              <p className="showcase-label">HTML snippet</p>
              <SnippetWindow title="embed.html" code={embedCode} html={embedHtml} />
              <p className="mt-3 text-xs leading-relaxed text-ink-faint">Use your published share URL. Include the script once per page.</p>
            </div>
            <div className="min-w-0">
              <p className="showcase-label">Live preview</p>
              <LiveEmbed snapshotUrl={snapshotUrl} />
            </div>
          </div>
        </article>

        <article className="mt-10 border-t border-line pt-10">
          <div className="mb-5 flex items-start gap-3">
            <FileText size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div>
              <h3 className="font-semibold text-ink">Add an open button</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-dim">Turn a public Markdown file into a prompt readers can bring into their own library.</p>
            </div>
          </div>
          <div className="grid min-w-0 items-start gap-6 md:grid-cols-2 lg:gap-8">
            <div className="min-w-0">
              <p className="showcase-label">HTML snippet</p>
              <SnippetWindow title="open-button.html" code={buttonCode} html={buttonHtml} />
              <p className="mt-3 text-xs leading-relaxed text-ink-faint">Use a public HTTPS Markdown URL. Readers review before importing.</p>
            </div>
            <div className="min-w-0">
              <p className="showcase-label">Live preview</p>
              <div className="code-box showcase-preview">
                <div className="code-box-bar">
                  <span className="code-box-dots" aria-hidden><i /><i /><i /></span>
                  <span className="code-box-title">code-review.md</span>
                  <span className="px-2.5 py-1.5 text-xs text-ink-faint">Preview</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-8 text-center">
                <a href={deepLink} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "12px 18px", borderRadius: 8, background: "#315ee8", color: "#fff", font: "600 14px system-ui", textDecoration: "none" }} className="transition-[filter,transform] hover:brightness-110 active:translate-y-px">
                  Open in PromptBranch <span aria-hidden>↗</span>
                </a>
                <p className="mt-5 max-w-xs text-xs leading-relaxed text-ink-dim">PromptBranch opens a review dialog. You choose when to fetch and import.</p>
                <a href={markdownUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:text-accent-strong">View example Markdown <ArrowUpRight size={12} aria-hidden /></a>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
