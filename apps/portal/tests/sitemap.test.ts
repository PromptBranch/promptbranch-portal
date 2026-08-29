import { afterEach, describe, expect, it, vi } from "vitest";
import sitemap from "@/app/sitemap";

describe("sitemap.xml", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists the landing page, docs index, and every docs page", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain("https://portal.example/");
    expect(urls).toContain("https://portal.example/docs");
    expect(urls).toContain("https://portal.example/docs/getting-started/overview");
    expect(urls).toContain("https://portal.example/docs/sharing/link-sharing-and-portal");
    expect(urls).toContain("https://portal.example/docs/reference/updates");
    // "/" + "/docs" + all 16 declared docs pages.
    expect(urls).toHaveLength(18);
  });

  it("never lists snapshot pages (unlisted by design)", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    for (const url of sitemap().map((entry) => entry.url)) {
      expect(url).not.toMatch(/\/p\/[A-Za-z0-9_-]/);
    }
  });
});
