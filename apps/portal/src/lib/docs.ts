import fs from "node:fs";
import path from "node:path";
import { extractToc, renderDocMarkdown, type TocItem } from "./docs-markdown";

export interface DocCategory {
  id: string;
  title: string;
  items: DocNavItem[];
}

export interface DocNavItem {
  slug: string;
  slugArray: string[];
  title: string;
  description: string;
}

export interface DocPage {
  slug: string;
  slugArray: string[];
  title: string;
  description: string;
  category: string;
  contentHtml: string;
  rawMarkdown: string;
  toc: TocItem[];
}

export interface DocSearchResult {
  slug: string;
  title: string;
  category: string;
  snippet: string;
}

/** Static navigation definition declaring the exact category structure and page ordering. */
export const DOCS_STRUCTURE: Array<{
  categoryId: string;
  categoryTitle: string;
  pages: Array<{
    slug: string; // e.g. "getting-started/overview"
    file: string; // relative to docs-content
    title: string;
    description: string;
  }>;
}> = [
  {
    categoryId: "getting-started",
    categoryTitle: "Getting Started",
    pages: [
      {
        slug: "getting-started/overview",
        file: "getting-started/overview.md",
        title: "Overview & Philosophy",
        description: "Introduction to PromptBranch: local-first prompt library and version control.",
      },
      {
        slug: "getting-started/installation",
        file: "getting-started/installation.md",
        title: "Installation & Setup",
        description: "Download and install the Desktop app (macOS, Windows, Linux), CLI, and MCP server.",
      },
      {
        slug: "getting-started/quickstart",
        file: "getting-started/quickstart.md",
        title: "5-Minute Quickstart",
        description: "Your first prompt, variables, multi-model run, version branching, and sharing.",
      },
      {
        slug: "getting-started/core-concepts",
        file: "getting-started/core-concepts.md",
        title: "Core Concepts",
        description: "Prompts, branches, sequential versions, ratings, and the SQLite single-file store.",
      },
    ],
  },
  {
    categoryId: "features",
    categoryTitle: "Features & Workflows",
    pages: [
      {
        slug: "features/prompt-management",
        file: "features/prompt-management.md",
        title: "Prompt Management & Versioning",
        description: "Creating, editing drafts, commit-like versions, change notes, and diff views.",
      },
      {
        slug: "features/search-and-organization",
        file: "features/search-and-organization.md",
        title: "Search, Tags & Collections",
        description: "FTS5 instant full-text search (⌘K), BM25 ranking, tags, collections, and starred prompts.",
      },
      {
        slug: "features/ai-execution-and-models",
        file: "features/ai-execution-and-models.md",
        title: "Multi-Model Execution & Cost",
        description: "Run up to 6 models concurrently with streaming output, latency, token, and estimated cost data.",
      },
      {
        slug: "features/llm-judge-and-evaluations",
        file: "features/llm-judge-and-evaluations.md",
        title: "LLM Judge & Evaluations",
        description: "4-dimension evaluation rubric, automated LLM scoring, and side-by-side run compare.",
      },
      {
        slug: "features/ai-assist",
        file: "features/ai-assist.md",
        title: "AI Prompt Assist",
        description: "Draft prompts from goal descriptions and improve prompts with natural language instructions.",
      },
    ],
  },
  {
    categoryId: "integrations",
    categoryTitle: "Agent & Dev Integrations",
    pages: [
      {
        slug: "integrations/mcp-server",
        file: "integrations/mcp-server.md",
        title: "MCP Server Integration",
        description: "Connect Claude Desktop, Cursor, and Windsurf via Model Context Protocol stdio.",
      },
      {
        slug: "integrations/cli",
        file: "integrations/cli.md",
        title: "Command-Line Interface (CLI)",
        description: "Use promptbranch in shell pipelines, scripts, and automation workflows.",
      },
      {
        slug: "integrations/ai-providers",
        file: "integrations/ai-providers.md",
        title: "AI Providers & Encryption",
        description: "Configure OpenAI, Anthropic, Google, and local OpenAI-compatible endpoints with safeStorage.",
      },
    ],
  },
  {
    categoryId: "sync",
    categoryTitle: "Multi-Device Sync",
    pages: [
      {
        slug: "sync/peer-to-peer-sync",
        file: "sync/peer-to-peer-sync.md",
        title: "Peer-to-Peer LAN Sync",
        description: "Serverless multi-device sync, mDNS peer discovery, TLS pinning, and HLC conflict resolution.",
      },
    ],
  },
  {
    categoryId: "sharing",
    categoryTitle: "Sharing & Portal",
    pages: [
      {
        slug: "sharing/link-sharing-and-portal",
        file: "sharing/link-sharing-and-portal.md",
        title: "Link Sharing & Secret Scanning",
        description: "Immutable snapshot publishing, secret scanning rules, delete tokens, and import workflows.",
      },
    ],
  },
  {
    categoryId: "reference",
    categoryTitle: "Configuration & Reference",
    pages: [
      {
        slug: "reference/configuration-and-env",
        file: "reference/configuration-and-env.md",
        title: "Configuration & Environment",
        description: "Environment variables, database path resolution, and storage directories.",
      },
      {
        slug: "reference/updates",
        file: "reference/updates.md",
        title: "Updates",
        description: "Automatic and manual update checks, installation choices, and platform support.",
      },
    ],
  },
];

const DOCS_DIR = path.join(process.cwd(), "src", "docs-content");

/** Reads raw markdown file content from src/docs-content. */
function readDocFile(relativePath: string): string {
  const fullPath = path.join(DOCS_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    return `# Document Not Found\n\nThe requested documentation page \`${relativePath}\` was not found.`;
  }
  return fs.readFileSync(fullPath, "utf8");
}

/**
 * Rewrites relative `.md` links (GitBook/GitHub style, e.g. `../features/x.md`)
 * into `/docs/<slug>` routes so pages copied verbatim from the main repository's
 * docs/ directory link correctly inside the app. Absolute and http(s) links,
 * and anything inside fenced code blocks, are left untouched.
 */
function rewriteDocLinks(md: string, currentFile: string): string {
  const dir = path.posix.dirname(currentFile);
  const linkPattern = /\[([^\]]*)\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/g;

  const resolve = (target: string): string | null => {
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) return null;
    const out: string[] = [];
    for (const part of `${dir}/${target}`.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return `/docs/${out.join("/").replace(/\.md$/, "")}`;
  };

  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(linkPattern, (match, text: string, target: string, anchor?: string) => {
        const resolved = resolve(target);
        return resolved === null ? match : `[${text}](${resolved}${anchor ?? ""})`;
      });
    })
    .join("\n");
}

/** Builds the categorized navigation sidebar items. */
export function getDocsNavigation(): DocCategory[] {
  return DOCS_STRUCTURE.map((cat) => ({
    id: cat.categoryId,
    title: cat.categoryTitle,
    items: cat.pages.map((p) => ({
      slug: p.slug,
      slugArray: p.slug.split("/"),
      title: p.title,
      description: p.description,
    })),
  }));
}

/** Flattened list of all document pages for static path generation. */
export function getAllDocPagesMeta(): Array<{ slug: string; slugArray: string[]; title: string; category: string }> {
  const result: Array<{ slug: string; slugArray: string[]; title: string; category: string }> = [];
  for (const cat of DOCS_STRUCTURE) {
    for (const p of cat.pages) {
      result.push({
        slug: p.slug,
        slugArray: p.slug.split("/"),
        title: p.title,
        category: cat.categoryTitle,
      });
    }
  }
  return result;
}

/** Fetches and renders a single doc page by slug string or slug array. */
export async function getDocPage(slug: string | string[]): Promise<DocPage | null> {
  const slugStr = Array.isArray(slug) ? slug.join("/") : slug;
  
  let targetPage: { slug: string; file: string; title: string; description: string } | null = null;
  let categoryTitle = "";

  for (const cat of DOCS_STRUCTURE) {
    const found = cat.pages.find((p) => p.slug === slugStr);
    if (found) {
      targetPage = found;
      categoryTitle = cat.categoryTitle;
      break;
    }
  }

  if (!targetPage) return null;

  const rawMarkdown = rewriteDocLinks(readDocFile(targetPage.file), targetPage.file);
  const toc = extractToc(rawMarkdown);
  const contentHtml = await renderDocMarkdown(rawMarkdown);

  return {
    slug: targetPage.slug,
    slugArray: targetPage.slug.split("/"),
    title: targetPage.title,
    description: targetPage.description,
    category: categoryTitle,
    contentHtml,
    rawMarkdown,
    toc,
  };
}

/** Finds previous and next doc pages in the linear reading order. */
export function getNeighborPages(currentSlug: string): {
  prev: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
} {
  const flatPages: Array<{ slug: string; title: string }> = [];
  for (const cat of DOCS_STRUCTURE) {
    for (const p of cat.pages) {
      flatPages.push({ slug: p.slug, title: p.title });
    }
  }

  const index = flatPages.findIndex((p) => p.slug === currentSlug);
  if (index === -1) return { prev: null, next: null };

  const prev = index > 0 ? (flatPages[index - 1] ?? null) : null;
  const next = index < flatPages.length - 1 ? (flatPages[index + 1] ?? null) : null;

  return { prev, next };
}

/** Returns searchable snippets for client-side search modal. */
export function getDocsSearchIndex(): DocSearchResult[] {
  const results: DocSearchResult[] = [];
  for (const cat of DOCS_STRUCTURE) {
    for (const p of cat.pages) {
      const raw = readDocFile(p.file);
      // Clean markdown tags for snippet search
      const cleanBody = raw
        .replace(/^#+\s+.+$/gm, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
        .replace(/\n+/g, " ")
        .slice(0, 300);

      results.push({
        slug: p.slug,
        title: p.title,
        category: cat.categoryTitle,
        snippet: `${p.description} — ${cleanBody}`,
      });
    }
  }
  return results;
}
