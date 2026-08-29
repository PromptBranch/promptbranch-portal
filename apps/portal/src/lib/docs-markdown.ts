import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { getHighlighter, THEMES } from "./highlight";

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/** Converts heading text to a URL-friendly slug ID. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Escapes HTML entities. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Extracts table of contents headings (h2, h3) from raw markdown. */
export function extractToc(markdown: string): TocItem[] {
  const lines = markdown.split("\n");
  const toc: TocItem[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match && h2Match[1]) {
      const text = h2Match[1].replace(/`([^`]+)`/g, "$1").trim();
      toc.push({ id: slugify(text), text, level: 2 });
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match && h3Match[1]) {
      const text = h3Match[1].replace(/`([^`]+)`/g, "$1").trim();
      toc.push({ id: slugify(text), text, level: 3 });
      continue;
    }
  }

  return toc;
}

/** Pre-processes GitHub-style callouts: `> [!NOTE]` into custom HTML containers. */
function preprocessCallouts(md: string): string {
  const alertTypes = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
  const pattern = new RegExp(
    `^>\\s*\\[!(${alertTypes.join("|")})\\]\\s*\\n((?:>.*\\n?)*)`,
    "gmi",
  );

  return md.replace(pattern, (_, type: string, content: string) => {
    const cleanContent = content
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    const kind = type.toLowerCase();
    return `<div class="callout callout-${kind}">\n<div class="callout-header"><span class="callout-title">${type}</span></div>\n<div class="callout-body">\n\n${cleanContent}\n\n</div>\n</div>\n`;
  });
}

/** Pre-processes Mermaid diagrams into renderable container divs. */
function preprocessMermaid(md: string): string {
  return md.replace(/```mermaid\r?\n([\s\S]*?)\r?\n```/g, (_, code: string) => {
    const trimmed = code.trim();
    const encoded = encodeURIComponent(trimmed);
    return `<div class="mermaid-diagram" data-code="${encoded}"><pre class="mermaid-loading">${escapeHtml(trimmed)}</pre></div>\n`;
  });
}

/** Custom sanitize schema that allows heading IDs, callouts, and mermaid attributes. */
const docsSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    h1: [...(defaultSchema.attributes?.["h1"] ?? []), "id"],
    h2: [...(defaultSchema.attributes?.["h2"] ?? []), "id"],
    h3: [...(defaultSchema.attributes?.["h3"] ?? []), "id"],
    h4: [...(defaultSchema.attributes?.["h4"] ?? []), "id"],
    div: [...(defaultSchema.attributes?.["div"] ?? []), "className", "class", "data-code"],
    span: [...(defaultSchema.attributes?.["span"] ?? []), "className", "class"],
    kbd: [...(defaultSchema.attributes?.["kbd"] ?? []), "className", "class"],
    code: [...(defaultSchema.attributes?.["code"] ?? []), "className", "class"],
    pre: [...(defaultSchema.attributes?.["pre"] ?? []), "className", "class"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "kbd"],
};

/** Rehype plugin to assign IDs to h2 and h3 elements. */
function rehypeHeadingIds() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (node.type === "element" && (node.tagName === "h2" || node.tagName === "h3" || node.tagName === "h4")) {
        const text = extractTextFromHast(node);
        if (text) {
          node.properties = node.properties || {};
          node.properties.id = slugify(text);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

function extractTextFromHast(node: any): string {
  if (node.type === "text") return node.value || "";
  if (!node.children) return "";
  return node.children.map(extractTextFromHast).join("");
}

/**
 * Server-side markdown rendering for the documentation system.
 * Handles GFM, heading IDs, GitHub callout alerts, Mermaid diagrams, and code highlighting via Shiki.
 */
export async function renderDocMarkdown(md: string): Promise<string> {
  const withCallouts = preprocessCallouts(md);
  const processed = preprocessMermaid(withCallouts);

  const run = async (withHighlight: boolean): Promise<string> => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeHeadingIds)
      .use(rehypeSanitize, docsSanitizeSchema);

    if (withHighlight) {
      const highlighter = await getHighlighter();
      processor.use(rehypeShikiFromHighlighter, highlighter, {
        themes: THEMES,
        defaultColor: false,
        fallbackLanguage: "plaintext",
      });
    }

    return String(await processor.use(rehypeStringify).process(processed));
  };

  try {
    return await run(true);
  } catch {
    return await run(false);
  }
}
