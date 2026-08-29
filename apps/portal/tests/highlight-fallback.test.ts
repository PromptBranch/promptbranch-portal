import { describe, expect, it, vi } from "vitest";
import { createHighlighter } from "shiki";
import { highlightSource } from "@/lib/highlight";
import { markdownToHtml } from "@/lib/markdown-to-html";

// Whole-file shiki mock: every createHighlighter call rejects. This file
// proves the degradation contract — highlightSource must resolve to plain
// fallback HTML, never reject — which the sibling highlight.test.ts cannot
// test because its shiki mock (the real one) must keep working.
vi.mock("shiki", () => ({
  createHighlighter: vi.fn(() => Promise.reject(new Error("shiki unavailable"))),
}));

describe("highlightSource when the highlighter cannot be created", () => {
  it("resolves to escaped plain fallback html instead of rejecting", async () => {
    const html = await highlightSource('code <b> "q"', "markdown");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&quot;q&quot;");
    expect(html).toMatch(/<pre class="shiki"/);
    expect(html).toMatch(/class="line"/);
  });

  it("still resolves on a second call — the rejected singleton was reset, not cached", async () => {
    vi.mocked(createHighlighter).mockClear();
    await highlightSource("first", "markdown");
    const second = await highlightSource("two & <three>", "markdown");
    expect(second).toContain("&amp;");
    expect(second).toContain("&lt;three&gt;");
    // Each highlightSource call attempts creation twice (original + plaintext
    // retry), so two calls mean 4 createHighlighter invocations. A poisoned
    // cache would keep this at 0 — the retries prove the reset happened.
    expect(vi.mocked(createHighlighter)).toHaveBeenCalledTimes(4);
  });
});

describe("markdownToHtml when the highlighter cannot be created", () => {
  it("resolves to sanitized unhighlighted html instead of rejecting", async () => {
    // page.tsx awaits this in a Promise.all with no catch — a rejection here
    // would 500 the whole rendered view, so the shiki failure must degrade.
    const html = await markdownToHtml("**bold**");
    expect(html).toContain("<strong>bold</strong>");
  });
});
