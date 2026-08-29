import { createHighlighter, type Highlighter } from "shiki";

/**
 * Server-side Shiki highlighting for the snapshot viewer. One highlighter
 * per process (grammar/theme loading is expensive); dual themes are emitted
 * as CSS custom properties (defaultColor:false) so dark/light switching is
 * pure CSS — see the .shiki rules in globals.css.
 */
export const THEMES = { light: "github-light", dark: "github-dark" } as const;

const COMMON_LANGS = [
  "markdown",
  "typescript",
  "tsx",
  "javascript",
  "python",
  "bash",
  "json",
  "sql",
  "css",
  "html",
  "yaml",
  "diff",
  "plaintext",
];

let singleton: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  // Caching a rejected promise would poison every future call for the
  // process lifetime — reset the slot on failure so the next call retries
  // creation (transient failures self-heal instead of sticking).
  singleton ??= createHighlighter({ themes: [...Object.values(THEMES)], langs: COMMON_LANGS }).catch(
    (error) => {
      singleton = null;
      throw error;
    },
  );
  return singleton;
}

/** Escapes the four characters HTML treats specially. `&` must come first,
    or the entities introduced by the later replacements get double-escaped. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Minimal plain-text fallback shaped like Shiki output (`pre.shiki` +
    one `.line` span per line) so the source-view CSS — line gutter included
    — keeps working without a highlighter. */
export function plainSourceHtml(code: string): string {
  const lines = code
    .split("\n")
    .map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return `<pre class="shiki">${lines.join("")}</pre>`;
}

/** Highlights `code` as `lang`; unknown languages fall back to plain text
    (a code box must never blank the page over a stray fence language). If no
    highlighter can be created at all, degrades to `plainSourceHtml` — this
    must always resolve, because page.tsx awaits it in a Promise.all with no
    catch. */
export async function highlightSource(code: string, lang = "markdown"): Promise<string> {
  const options = { themes: THEMES, defaultColor: false } as const;
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, { lang, ...options });
  } catch {
    try {
      // Retry re-creates the highlighter (singleton was reset); unknown
      // languages get a second chance as plaintext here.
      const highlighter = await getHighlighter();
      return highlighter.codeToHtml(code, { lang: "plaintext", ...options });
    } catch {
      return plainSourceHtml(code);
    }
  }
}
