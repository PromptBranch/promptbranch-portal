import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import OgImage, { contentType, dynamic, size, truncate } from "@/app/p/[id]/opengraph-image";
import { getDb, insertSnapshot } from "@/lib/db";

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
});

describe("opengraph-image", () => {
  it("exports the standard 1200x630 PNG contract", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("is force-dynamic so deleted snapshots never serve a stale card", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns an image response for unknown ids (fallback branding)", async () => {
    const response = await OgImage({ params: Promise.resolve({ id: "missingmissingmissi" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
  });

  it("renders a snapshot with a 200-char title without breaking the card", async () => {
    insertSnapshot(getDb(), {
      id: "longtitlelongtitlelon",
      payload: JSON.stringify({ title: "T".repeat(200), tags: ["a".repeat(60)] }),
      contentHash: "a".repeat(64),
      parentId: null,
      publishedAt: "2026-08-25T12:00:00.000Z",
      publisherIpHash: "b".repeat(64),
    });
    const response = await OgImage({ params: Promise.resolve({ id: "longtitlelongtitlelon" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 80)).toBe("hello");
  });

  it("returns text at exactly the max unchanged", () => {
    expect(truncate("x".repeat(80), 80)).toBe("x".repeat(80));
  });

  it("truncates beyond the max to max chars with a single ellipsis", () => {
    const result = truncate("x".repeat(200), 80);
    expect(result).toBe("x".repeat(79) + "…");
    expect(result).toHaveLength(80);
  });
});
