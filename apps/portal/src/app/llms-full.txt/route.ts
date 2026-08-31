import { getAllDocPagesMeta, getDocMarkdown } from "@/lib/docs";
import { getEnv } from "@/lib/env";

// A single Markdown source lets an agent read the complete public manual
// without navigating UI chrome or discovering every documentation route.
// It intentionally contains repository-authored docs only, never snapshots.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withoutPageTitle(markdown: string): string {
  return markdown.replace(/^#\s+.+\n+/, "").trim();
}

/** Documentation may show a sample share URL. Never turn a concrete,
    unlisted snapshot id into a crawler-discoverable link in this aggregate. */
function redactSnapshotIds(markdown: string): string {
  return markdown.replace(/\/p\/[A-Za-z0-9_-]{21}/g, "/p/<id>");
}

export function GET(): Response {
  const base = getEnv().PUBLIC_BASE_URL;
  const lines = [
    "# PromptBranch documentation",
    "",
    "> Complete public Markdown documentation for PromptBranch, a local-first desktop app for organizing, versioning, evaluating, and sharing AI prompts.",
    "",
    `Canonical product site: ${base}/`,
  ];

  for (const page of getAllDocPagesMeta()) {
    const doc = getDocMarkdown(page.slug);
    if (!doc) continue;
    lines.push(
      "",
      `## ${doc.title}`,
      "",
      `Canonical URL: ${base}/docs/${doc.slug}`,
      "",
      redactSnapshotIds(withoutPageTitle(doc.rawMarkdown)),
    );
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
