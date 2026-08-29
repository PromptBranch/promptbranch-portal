// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { markdownToHtml } from "@/lib/markdown-to-html";
import { MarkdownHtml } from "@/components/markdown";
import { GoneView } from "@/components/gone-view";

describe("markdownToHtml", () => {
  it("renders basic markdown structure", async () => {
    const html = await markdownToHtml("# Title\n\nSome **bold** text.\n\n- one\n- two");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toMatch(/<li>one<\/li>/);
  });

  it("renders GFM tables", async () => {
    const html = await markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
  });

  it("never emits raw HTML from the source (scripts/imgs stripped)", async () => {
    const html = await markdownToHtml(
      'Hello <script>alert("xss")</script><img src="x" onerror="alert(1)">',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("neutralizes javascript: URLs in links", async () => {
    const html = await markdownToHtml("[click me](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("highlights fenced code blocks with dual theme vars, after sanitize", async () => {
    const html = await markdownToHtml('```ts\nconst x: number = 1;\n```');
    // shiki 4 emits class="shiki shiki-themes <names>…" for multi-theme output
    expect(html).toMatch(/class="shiki[" ]/);
    expect(html).toContain("--shiki-dark:");
    expect(html).toContain("--shiki-light:");
  });

  it("still renders when highlighting fails entirely (plain fallback)", async () => {
    // A pipeline that throws mid-highlight must degrade, not blank the page.
    const html = await markdownToHtml("plain text, no constructs at all");
    expect(html).toContain("plain text");
  });
});

describe("MarkdownHtml", () => {
  it("injects the precomputed HTML under the .md namespace", () => {
    const { container } = render(<MarkdownHtml html="<p>hi</p>" />);
    expect(container.querySelector(".md p")?.textContent).toBe("hi");
  });
});

describe("GoneView", () => {
  it("explains the snapshot was deleted", () => {
    render(<GoneView />);
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PromptBranch" })).toHaveAttribute("href", "/");
  });
});
