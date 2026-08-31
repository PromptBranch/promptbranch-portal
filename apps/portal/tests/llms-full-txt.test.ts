import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/llms-full.txt/route";

describe("GET /llms-full.txt", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("serves the complete public documentation in Markdown", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://portal.example");
    const response = await GET();

    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("# PromptBranch documentation");
    expect(text).toContain("## Installation, Setup & Build from Source");
    expect(text).toContain("## MCP Server");
    expect(text).toContain("## Share a Prompt");
    expect(text).toContain("https://portal.example/docs/getting-started/overview");
  });

  it("contains no unlisted snapshot links", async () => {
    const text = await (await GET()).text();
    expect(text).not.toMatch(/\/p\/[A-Za-z0-9_-]/);
  });
});
