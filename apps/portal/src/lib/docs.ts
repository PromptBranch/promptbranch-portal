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

export interface DocMarkdown {
  slug: string;
  slugArray: string[];
  title: string;
  description: string;
  category: string;
  rawMarkdown: string;
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
        title: "Overview",
        description: "What PromptBranch does and where your prompt library lives.",
      },
      {
        slug: "getting-started/installation",
        file: "getting-started/installation.md",
        title: "Installation, Setup & Build from Source",
        description: "Install the desktop app, CLI, or MCP server, or build PromptBranch from source.",
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
        description: "Prompts, versions, variations, results, and agent suggestions.",
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
        title: "Manage Prompts & Versions",
        description: "Edit drafts, save versions, try variations, compare changes, and recover prompts.",
      },
      {
        slug: "features/search-and-organization",
        file: "features/search-and-organization.md",
        title: "Search & Organize Prompts",
        description: "Find prompts and organize them with tags, collections, stars, and notes.",
      },
      {
        slug: "features/library-data-and-backups",
        file: "features/library-data-and-backups.md",
        title: "Library Data, Backups & Transfer",
        description: "Back up, export, import, and review activity in your local library.",
      },
      {
        slug: "features/ai-execution-and-models",
        file: "features/ai-execution-and-models.md",
        title: "Run Prompts with AI Models",
        description: "Run up to six connected models and compare outputs, timing, tokens, and cost estimates.",
      },
      {
        slug: "features/llm-judge-and-evaluations",
        file: "features/llm-judge-and-evaluations.md",
        title: "Evaluate Prompt Results",
        description: "Compare outputs, add ratings, and use an optional AI judge.",
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
    categoryTitle: "Agent Integrations",
    pages: [
      {
        slug: "integrations/mcp-server",
        file: "integrations/mcp-server.md",
        title: "MCP Server",
        description: "Connect an MCP-capable coding agent or harness to your local library.",
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
        title: "Connect AI Providers",
        description: "Set up cloud or local AI providers and manage the models you use.",
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
        title: "Sync Between Your Devices",
        description: "Pair devices, configure their listening ports, and troubleshoot local-network, VPN, or firewall connections.",
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
        title: "Share a Prompt",
        description: "Publish, revoke, and import immutable prompt snapshots.",
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
        description: "Choose a different library, use environment keys, and connect devices.",
      },
      {
        slug: "reference/updates",
        file: "reference/updates.md",
        title: "Updates",
        description: "Automatic and manual update checks, installation choices, and platform support.",
      },
      {
        slug: "reference/contributing",
        file: "reference/contributing.md",
        title: "Contributing",
        description: "Build PromptBranch locally and prepare a focused contribution.",
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

/** Reads a public documentation page as normalized Markdown without rendering it. */
export function getDocMarkdown(slug: string | string[]): DocMarkdown | null {
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

  return {
    slug: targetPage.slug,
    slugArray: targetPage.slug.split("/"),
    title: targetPage.title,
    description: targetPage.description,
    category: categoryTitle,
    rawMarkdown: rewriteDocLinks(readDocFile(targetPage.file), targetPage.file),
  };
}

/** Fetches and renders a single doc page by slug string or slug array. */
export async function getDocPage(slug: string | string[]): Promise<DocPage | null> {
  const doc = getDocMarkdown(slug);
  if (!doc) return null;

  const { rawMarkdown } = doc;
  const toc = extractToc(rawMarkdown);
  const contentHtml = await renderDocMarkdown(rawMarkdown);

  return {
    ...doc,
    contentHtml,
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
