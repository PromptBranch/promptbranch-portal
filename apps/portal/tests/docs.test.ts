import { describe, expect, it } from "vitest";
import {
  getAllDocPagesMeta,
  getDocPage,
  getDocsNavigation,
  getDocsSearchIndex,
  getNeighborPages,
} from "@/lib/docs";
import { extractToc, slugify } from "@/lib/docs-markdown";

describe("documentation engine", () => {
  it("generates a structured navigation tree", () => {
    const nav = getDocsNavigation();
    expect(nav.length).toBeGreaterThanOrEqual(5);

    const categoryIds = nav.map((c) => c.id);
    expect(categoryIds).toContain("getting-started");
    expect(categoryIds).toContain("features");
    expect(categoryIds).toContain("integrations");
    expect(categoryIds).toContain("sync");
    expect(categoryIds).toContain("sharing");
    expect(categoryIds).toContain("reference");
  });

  it("slugifies text into URL-safe identifiers", () => {
    expect(slugify("Overview & Philosophy")).toBe("overview-philosophy");
    expect(slugify("Multi-Model Execution & Cost")).toBe("multi-model-execution-cost");
    expect(slugify("SQLite `better-sqlite3` Store")).toBe("sqlite-better-sqlite3-store");
  });

  it("extracts TOC headings from markdown accurately", () => {
    const md = `
# Title
Intro text

## First Section
Some content

### Sub Section
More content

\`\`\`markdown
## Code heading inside block
\`\`\`

## Second Section
End content
`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(3);
    expect(toc[0]).toEqual({ id: "first-section", text: "First Section", level: 2 });
    expect(toc[1]).toEqual({ id: "sub-section", text: "Sub Section", level: 3 });
    expect(toc[2]).toEqual({ id: "second-section", text: "Second Section", level: 2 });
  });

  it("loads and renders documentation pages with Shiki highlighting", async () => {
    const page = await getDocPage("getting-started/overview");
    expect(page).not.toBeNull();
    expect(page?.title).toBe("Overview");
    expect(page?.category).toBe("Getting Started");
    expect(page?.contentHtml).toContain("PromptBranch");
    expect(page?.toc.length).toBeGreaterThan(0);
  });

  it("publishes the current desktop update guide in the reference section", async () => {
    const page = await getDocPage("reference/updates");
    expect(page).not.toBeNull();
    expect(page?.title).toBe("Updates");
    expect(page?.category).toBe("Configuration & Reference");
    expect(page?.contentHtml).toMatch(/Check for Updates/);
  });

  it("rewrites relative .md links into /docs routes", async () => {
    const page = await getDocPage("getting-started/quickstart");
    expect(page?.contentHtml).toContain('href="/docs/features/prompt-management"');
    expect(page?.contentHtml).not.toContain('href="../features');
  });

  it("returns null for non-existent doc pages", async () => {
    const page = await getDocPage("non-existent-page");
    expect(page).toBeNull();
  });

  it("renders every declared page end-to-end", async () => {
    for (const meta of getAllDocPagesMeta()) {
      const page = await getDocPage(meta.slug);
      expect(page, meta.slug).not.toBeNull();
      expect(page?.contentHtml.length, meta.slug).toBeGreaterThan(0);
      expect(page?.toc.length, meta.slug).toBeGreaterThan(0);
    }
  });

  it("computes linear neighbor pagination (prev/next)", () => {
    const meta = getAllDocPagesMeta();
    expect(meta.length).toBeGreaterThan(5);

    const first = getNeighborPages(meta[0]!.slug);
    expect(first.prev).toBeNull();
    expect(first.next).not.toBeNull();
    expect(first.next?.slug).toBe(meta[1]!.slug);

    const middle = getNeighborPages(meta[1]!.slug);
    expect(middle.prev?.slug).toBe(meta[0]!.slug);
    expect(middle.next?.slug).toBe(meta[2]!.slug);
  });

  it("builds a searchable snippet index across all docs", () => {
    const searchIndex = getDocsSearchIndex();
    expect(searchIndex.length).toBe(getAllDocPagesMeta().length);

    for (const entry of searchIndex) {
      expect(entry.slug).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.snippet).toBeTruthy();
    }
  });

  it("indexes the sync guide for listening-port searches", () => {
    const query = "listening port";
    const matches = getDocsSearchIndex().filter((entry) =>
      [entry.title, entry.category, entry.snippet]
        .some((value) => value.toLowerCase().includes(query)),
    );

    expect(matches.map((entry) => entry.slug)).toContain("sync/peer-to-peer-sync");
  });
});
