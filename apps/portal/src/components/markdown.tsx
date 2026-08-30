/**
 * Presentational wrapper for HTML produced by markdownToHtml (server-side).
 * The HTML is sanitized before highlighting (see lib/markdown-to-html.ts),
 * so injection here is safe by construction — no client-side renderer or
 * bundle involved.
 */
export function MarkdownHtml({ html }: { html: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
