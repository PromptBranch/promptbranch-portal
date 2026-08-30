import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/llms.txt/route";

describe("GET /llms.txt", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("serves plain text indexing the product and every docs page", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    const response = GET();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("# PromptBranch");
    expect(text).toContain("https://portal.example/docs/getting-started/overview");
    expect(text).toContain("https://portal.example/docs/reference/configuration-and-env");
    expect(text).toContain("https://portal.example/docs/reference/updates");
    expect(text).toContain("https://github.com/PromptBranch/promptbranch");
  });

  it("never references snapshot links (unlisted by design)", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    const text = await GET().text();
    expect(text).not.toMatch(/\/p\/[A-Za-z0-9_-]/);
  });
});
