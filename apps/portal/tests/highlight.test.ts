import { describe, expect, it } from "vitest";
import { getHighlighter, highlightSource, plainSourceHtml } from "@/lib/highlight";

describe("highlightSource", () => {
  it("returns a shiki pre with one .line span per line and dual theme vars", async () => {
    const html = await highlightSource("# Title\n\nsome **bold** text", "markdown");
    // shiki 4 emits class="shiki shiki-themes <names>…" for multi-theme output
    expect(html).toMatch(/class="shiki[" ]/);
    // defaultColor:false — tokens carry both custom properties for CSS theming
    expect(html).toContain("--shiki-dark:");
    expect(html).toContain("--shiki-light:");
    const lines = html.match(/class="line"/g) ?? [];
    expect(lines.length).toBe(3); // "# Title", "", "some **bold** text"
  });

  it("falls back to plain text for an unknown language", async () => {
    const html = await highlightSource("just text", "no-such-lang-xyz");
    expect(html).toMatch(/class="shiki[" ]/);
  });

  it("returns the same singleton instance on repeated calls", async () => {
    const a = await getHighlighter();
    const b = await getHighlighter();
    expect(a).toBe(b);
  });
});

describe("plainSourceHtml", () => {
  it("escapes script content and HTML-special characters", () => {
    const html = plainSourceHtml('<script>alert("x")&</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<script>");
  });

  it("escapes & before the tag entities so nothing double-escapes", () => {
    expect(plainSourceHtml("a<b>&")).toBe(
      '<pre class="shiki"><span class="line">a&lt;b&gt;&amp;</span></pre>',
    );
  });

  it("emits one .line span per line of input", () => {
    const html = plainSourceHtml("one\ntwo\n\nthree");
    const lines = html.match(/class="line"/g) ?? [];
    expect(lines.length).toBe(4);
  });
});
