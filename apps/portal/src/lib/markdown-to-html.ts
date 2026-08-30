import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { getHighlighter, THEMES } from "./highlight";

/**
 * The viewer's whole markdown story, server-side. Order is security-critical:
 * GFM parse → hast → rehype-sanitize strips anything hostile → ONLY THEN does
 * Shiki add its generated (never user-supplied) spans; the async server
 * pipeline exists precisely so the async Shiki plugin can run here.
 * On any highlighter failure the same pipeline re-runs without Shiki — the
 * page degrades to unhighlighted-but-sanitized output instead of erroring.
 */
export async function markdownToHtml(md: string): Promise<string> {
  const run = async (withHighlight: boolean): Promise<string> => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSanitize, defaultSchema);
    if (withHighlight) {
      const highlighter = await getHighlighter();
      // The /core entry default-exports the factory; unified needs it as
      // `use(plugin, highlighter, options)` — calling it here would hand
      // unified the returned transformer where it expects an attacher.
      processor.use(rehypeShikiFromHighlighter, highlighter, {
        themes: THEMES,
        defaultColor: false,
        fallbackLanguage: "plaintext",
      });
    }
    return String(await processor.use(rehypeStringify).process(md));
  };
  try {
    return await run(true);
  } catch {
    return await run(false);
  }
}
