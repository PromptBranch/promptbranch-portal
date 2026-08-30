import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { generateMetadata } from "@/app/p/[id]/page";
import { getDb, insertSnapshot } from "@/lib/db";

const ID = "V1StGXR8_Z5jdHi6B-myT";
const SNAPSHOT = {
  formatVersion: 1,
  title: "security-audit",
  description: "Review code for security issues",
  content: "You are a security auditor.",
  tags: ["security"],
  publishedAt: "2026-08-25T12:00:00.000Z",
};

function seed(payload: unknown = SNAPSHOT): void {
  insertSnapshot(getDb(), {
    id: ID,
    payload: JSON.stringify(payload),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: "2026-08-25T12:00:00.000Z",
    publisherIpHash: "b".repeat(64),
  });
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
  process.env.PUBLIC_BASE_URL = "http://203.0.113.10:3000";
});

describe("generateMetadata for /p/[id]", () => {
  it("builds OG + Twitter meta for a live snapshot", async () => {
    seed();
    const metadata = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(metadata.title).toBe("security-audit");
    expect(metadata.description).toBe("Review code for security issues");
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.openGraph).toMatchObject({
      title: "security-audit",
      type: "article",
      siteName: "PromptBranch",
      url: `http://203.0.113.10:3000/p/${ID}`,
      tags: ["security"],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary", title: "security-audit" });
  });

  it("falls back to the first 160 chars of content without a description", async () => {
    seed({ ...SNAPSHOT, description: undefined, content: "x".repeat(200) });
    const metadata = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(metadata.description).toBe("x".repeat(160));
  });

  it("returns not-found meta for unknown ids", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "missingmissingmissi" }) });
    expect(metadata.title).toBe("Not found");
  });
});
