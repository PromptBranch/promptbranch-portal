// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeEmbeds, type EmbedResponse } from "@/embed/widget-runtime";

const ID = "V1StGXR8_Z5jdHi6B-myT";
const ORIGIN = "https://prompts.example";
const SNAPSHOT_URL = `${ORIGIN}/p/${ID}`;

const EMBED: EmbedResponse = {
  formatVersion: 1,
  id: ID,
  url: SNAPSHOT_URL,
  title: "Security prompt",
  description: "Review code carefully.",
  tags: ["security"],
  markdown: "# Review\n\nDo the work.",
  contentHtml: "<h1>Review</h1><p>Do the work.</p>",
  sourceHtml: "<pre class=\"shiki\"><code># Review</code></pre>",
};

function host(url = SNAPSHOT_URL): HTMLDivElement {
  const element = document.createElement("div");
  element.setAttribute("data-promptbranch-embed", url);
  return element;
}

function response(body: unknown = EMBED, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: `${ORIGIN}/api/embeds/${ID}`,
    json: vi.fn().mockResolvedValue(body),
  };
}

function initialize(fetcher = vi.fn().mockResolvedValue(response())) {
  return {
    fetcher,
    cleanup: initializeEmbeds({
      document,
      portalOrigin: ORIGIN,
      assetBaseUrl: ORIGIN,
      fetch: fetcher,
    }),
  };
}

async function flush(): Promise<void> {
  await vi.waitFor(() => {
    const mounted = [...document.querySelectorAll<HTMLElement>("[data-promptbranch-embed]")].some((target) =>
      target.shadowRoot?.querySelector("[data-pb-embed-window]"),
    );
    expect(mounted).toBe(true);
  });
}

describe("PromptBranch inline widget", () => {
  let mediaMatches = false;
  let mediaChange: ((event: MediaQueryListEvent) => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = "";
    mediaMatches = false;
    mediaChange = undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        get matches() { return mediaMatches; },
        media: "(prefers-color-scheme: light)",
        addEventListener: vi.fn((_event: string, callback: (event: MediaQueryListEvent) => void) => {
          mediaChange = callback;
        }),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    (window as Window & { __pbEmbedCleanup?: () => void }).__pbEmbedCleanup?.();
    document.body.innerHTML = "";
    delete (window as Window & { __pbEmbedCleanup?: () => void }).__pbEmbedCleanup;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  it("mounts one and two prompts, observes later nodes, and stays idempotent", async () => {
    const first = host();
    const second = host();
    document.body.append(first, second);
    const { fetcher, cleanup } = initialize();

    initialize();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.shadowRoot?.querySelectorAll("[data-pb-embed-window]")).toHaveLength(1);
    expect(second.shadowRoot?.querySelectorAll("[data-pb-embed-window]")).toHaveLength(1);

    const later = host();
    document.body.append(later);
    await vi.waitFor(() => expect(later.shadowRoot?.querySelector("[data-pb-embed-window]")).not.toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it("rejects invalid and cross-origin share URLs before fetching", () => {
    const bad = host("https://attacker.example/p/aaaaaaaaaaaaaaaaaaaaa");
    const malformed = host("javascript:alert(1)");
    document.body.append(bad, malformed);
    const { fetcher } = initialize();

    expect(fetcher).not.toHaveBeenCalled();
    expect(bad.shadowRoot).toBeNull();
    expect(malformed.shadowRoot).toBeNull();
    expect(document.querySelector("iframe, style, link[rel=stylesheet]")).toBeNull();
  });

  it.each([
    ["missing", 404],
    ["revoked", 410],
    ["rate limited", 429],
  ])("shows a safe unavailable state when the server reports %s", async (_label, status) => {
    const target = host();
    document.body.append(target);
    const { fetcher } = initialize(vi.fn().mockResolvedValue(response({}, status)));

    await vi.waitFor(() => expect(target.shadowRoot?.textContent).toContain("This shared prompt is unavailable."));
    expect(target.shadowRoot?.querySelector("a[href='" + SNAPSHOT_URL + "']")?.textContent).toBe("View full prompt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("handles network and malformed-response failures without rendering remote error text", async () => {
    for (const fetcher of [
      vi.fn().mockRejectedValue(new Error("private network detail")),
      vi.fn().mockResolvedValue(response({ ...EMBED, contentHtml: 42 })),
    ]) {
      const target = host();
      document.body.append(target);
      initialize(fetcher);

      await vi.waitFor(() => expect(target.shadowRoot?.textContent).toContain("This shared prompt is unavailable."));
      expect(target.shadowRoot?.textContent).not.toContain("private network detail");
      target.remove();
    }
  });

  it("toggles rendered and source views and exposes copy, app, and full-page actions", async () => {
    const target = host();
    document.body.append(target);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    initialize();
    await flush();

    const root = target.shadowRoot!;
    const rendered = root.querySelector<HTMLButtonElement>("[data-view-button='rendered']")!;
    const source = root.querySelector<HTMLButtonElement>("[data-view-button='source']")!;
    const frame = root.querySelector<HTMLElement>("[data-pb-embed-window]")!;
    expect(frame.dataset.view).toBe("rendered");
    source.click();
    expect(frame.dataset.view).toBe("source");
    expect(source.getAttribute("aria-pressed")).toBe("true");
    rendered.click();
    expect(frame.dataset.view).toBe("rendered");

    root.querySelector<HTMLButtonElement>("[data-copy-markdown]")!.click();
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(EMBED.markdown));
    expect(root.querySelector<HTMLAnchorElement>("[data-open-promptbranch]")?.href).toBe(
      `promptbranch://import?url=${encodeURIComponent(SNAPSHOT_URL)}`,
    );
    expect(root.querySelector<HTMLAnchorElement>("[data-view-full]")?.href).toBe(SNAPSHOT_URL);
    expect(root.querySelector("iframe, style")).toBeNull();
  });

  it("resolves auto theme from the OS and honors explicit light/dark overrides", async () => {
    const automatic = host();
    const light = host();
    const dark = host();
    light.setAttribute("data-promptbranch-theme", "light");
    dark.setAttribute("data-promptbranch-theme", "dark");
    document.body.append(automatic, light, dark);
    initialize();
    await flush();

    expect(automatic.dataset.pbThemeResolved).toBe("dark");
    expect(light.dataset.pbThemeResolved).toBe("light");
    expect(dark.dataset.pbThemeResolved).toBe("dark");
    mediaMatches = true;
    mediaChange?.({ matches: true } as MediaQueryListEvent);
    expect(automatic.dataset.pbThemeResolved).toBe("light");
  });

  it("keeps controls semantic and keyboard focusable, with assets scoped to the shadow root", async () => {
    const target = host();
    document.body.append(target);
    initialize();
    await flush();

    const root = target.shadowRoot!;
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      button.focus();
      expect(root.activeElement).toBe(button);
    }
    expect(root.querySelector("link[rel=stylesheet]")?.getAttribute("href")).toBe(`${ORIGIN}/embed.css`);
    expect(document.head.querySelector("link[rel=stylesheet], style")).toBeNull();
    expect(document.cookie).toBe("");
  });

  it("shares the portal window stylesheet without relying on global page styles", () => {
    const windowCss = readFileSync("src/app/prompt-window.css", "utf8");
    const portalCss = readFileSync("src/app/globals.css", "utf8");
    expect(windowCss).toContain(":root,");
    expect(windowCss).toContain(":host");
    expect(windowCss).toContain(".md {");
    expect(windowCss).toContain(".code-box {");
    expect(windowCss).toContain(".source-view {");
    expect(windowCss).toContain(".shiki");
    expect(portalCss).toContain('@import "./prompt-window.css";');
  });
});
