import { getDocsNavigation } from "@/lib/docs";
import { getEnv } from "@/lib/env";

// llms.txt (llmstxt.org convention): a plain-text index that AI search
// agents fetch to understand the site. Only stable, public content is
// listed — snapshot links are unguessable and unlisted by design, so they
// never appear here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const base = getEnv().PUBLIC_BASE_URL;
  const lines = [
    "# PromptBranch",
    "",
    "> PromptBranch is a local-first desktop app for organizing, versioning,",
    "> evaluating, and sharing AI prompts. This portal serves the product site,",
    "> documentation, and immutable unlisted share links (`/p/<id>`, excluded",
    "> from crawlers).",
    "",
    "## Docs",
    "",
  ];
  for (const category of getDocsNavigation()) {
    for (const page of category.items) {
      lines.push(`- [${page.title}](${base}/docs/${page.slug}): ${page.description}`);
    }
  }
  lines.push(
    "",
    "## Links",
    "",
    `- [PromptBranch home](${base}/): product overview and downloads`,
    "- [GitHub repository](https://github.com/PromptBranch/promptbranch): source code and releases",
    "- [Report an issue](https://github.com/PromptBranch/promptbranch/issues)",
  );
  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
