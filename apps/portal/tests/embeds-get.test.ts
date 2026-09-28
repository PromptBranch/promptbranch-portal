import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generateDeleteToken, hashToken } from "@promptbranch/share";
import { GET } from "@/app/api/embeds/[id]/route";
import { getDb, insertDeleteToken, insertSnapshot } from "@/lib/db";

const ID = "V1StGXR8_Z5jdHi6B-myT";
const PUBLISHED_AT = "2026-08-25T12:00:00.000Z";
let ipCounter = 1100;

function nextIp(): string {
  ipCounter += 1;
  return `10.97.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function seedSnapshot(content = "You are a security auditor."): string {
  const db = getDb();
  insertSnapshot(db, {
    id: ID,
    payload: JSON.stringify({
      formatVersion: 1,
      title: "Security prompt",
      description: "Review code carefully.",
      content,
      tags: ["security", "review"],
      history: [{ version: 1, content: "old", changeNote: "private history note" }],
      publishedAt: PUBLISHED_AT,
    }),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: PUBLISHED_AT,
    publisherIpHash: "b".repeat(64),
  });
  const deleteToken = generateDeleteToken();
  insertDeleteToken(db, ID, hashToken(deleteToken));
  return deleteToken;
}

function request(id: string, ip = nextIp()) {
  return GET(
    new NextRequest(`http://localhost/api/embeds/${id}`, { headers: { "x-forwarded-for": ip } }),
    { params: Promise.resolve({ id }) },
  );
}

function expectEmbedHeaders(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-embed-test-"));
  process.env.PUBLIC_BASE_URL = "https://prompts.example";
});

describe("GET /api/embeds/[id]", () => {
  it("returns the public embed shape with sanitized rendered and source HTML", async () => {
    const deleteToken = seedSnapshot(
      '# Hello\n\n<script>alert("xss")</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))',
    );

    const response = await request(ID);
    expect(response.status).toBe(200);
    expectEmbedHeaders(response);
    const body = await response.json();

    expect(body).toMatchObject({
      formatVersion: 1,
      id: ID,
      url: `https://prompts.example/p/${ID}`,
      title: "Security prompt",
      description: "Review code carefully.",
      tags: ["security", "review"],
      markdown: expect.stringContaining("<script>"),
      contentHtml: expect.stringContaining("<h1>Hello</h1>"),
      sourceHtml: expect.stringMatching(/<pre class="shiki\b/),
    });
    expect(body.contentHtml).not.toMatch(/<script|onerror|javascript:/i);
    expect(body.sourceHtml).not.toMatch(/<script\b|<img\b|<a\b/i);
    expect(body.contentHtml).not.toContain('style="');
    expect(body.sourceHtml).not.toContain('style="');
    expect(body.sourceHtml).toContain("&#x3C;img");
    expect(JSON.stringify(body)).not.toContain(deleteToken);
    expect(JSON.stringify(body)).not.toContain("private history note");
    expect(JSON.stringify(body)).not.toContain("deleteToken");
    expect(Object.keys(body).sort()).toEqual(
      ["contentHtml", "description", "formatVersion", "id", "markdown", "sourceHtml", "tags", "title", "url"].sort(),
    );
  });

  it("returns CORS-enabled 404 for missing and malformed IDs", async () => {
    const missing = await request("V1StGXR8_Z5jdHi6B-myU");
    expect(missing.status).toBe(404);
    expectEmbedHeaders(missing);

    const invalid = await request("bad");
    expect(invalid.status).toBe(404);
    expectEmbedHeaders(invalid);
  });

  it("returns CORS-enabled 410 for revoked snapshots", async () => {
    const token = seedSnapshot();
    getDb().prepare("UPDATE snapshots SET deleted_at = ? WHERE id = ?").run(PUBLISHED_AT, ID);
    expect(token).toBeTruthy();

    const response = await request(ID);
    expect(response.status).toBe(410);
    expectEmbedHeaders(response);
  });

  it("fails closed with CORS headers for damaged stored payloads", async () => {
    seedSnapshot();
    getDb().prepare("UPDATE snapshots SET payload = ? WHERE id = ?").run("{", ID);

    const response = await request(ID);
    expect(response.status).toBe(500);
    expectEmbedHeaders(response);
    expect(await response.json()).toEqual({ error: "unable to render snapshot" });
  });

  it("returns CORS-enabled 429 after the read budget is exhausted", async () => {
    const ip = nextIp();
    for (let index = 0; index < 300; index += 1) {
      await request("missingmissingmissi", ip);
    }

    const response = await request("missingmissingmissi", ip);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expectEmbedHeaders(response);
  });
});
