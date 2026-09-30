import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getEmbed } from "@/app/api/embeds/[id]/route";
import { GET as getStyles } from "@/app/api/embeds/[id]/styles.css/route";
import { GET as getSnapshot, DELETE } from "@/app/api/snapshots/[id]/route";
import { GET as getMarkdown } from "@/app/examples/code-review.md/route";
import { getDb } from "@/lib/db";

const id = "demo_code_review_0001";
const context = { params: Promise.resolve({ id }) };
let ip = 0;
const request = () => new NextRequest(`https://portal.example/api/snapshots/${id}`, {
  headers: { "x-forwarded-for": `10.96.0.${++ip}` },
});

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-demo-test-"));
  process.env.PUBLIC_BASE_URL = "https://portal.example";
});

it("serves the landing example to both the embed and desktop import without database writes", async () => {
  const snapshotResponse = await getSnapshot(request(), context);
  const embedResponse = await getEmbed(request(), context);
  expect(snapshotResponse.status).toBe(200);
  expect(embedResponse.status).toBe(200);
  const snapshot = await snapshotResponse.json();
  const embed = await embedResponse.json();
  expect(embed.url).toBe(`https://portal.example/p/${id}`);
  expect(embed.markdown).toBe(snapshot.snapshot.content);
  expect(embed.contentHtml).toContain("<h2>");
  expect(embed.sourceHtml).toContain("shiki");
  const markdown = getMarkdown(request());
  expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toBe(snapshot.snapshot.content);
  expect(embedResponse.headers.get("access-control-allow-origin")).toBe("*");
  expect((await getStyles(request(), context)).status).toBe(200);
  expect(getDb().prepare("SELECT count(*) AS count FROM snapshots").get()).toEqual({ count: 0 });
  expect(getDb().prepare("SELECT count(*) AS count FROM delete_tokens").get()).toEqual({ count: 0 });
});

it("does not turn a nonexistent ID into an example", async () => {
  const missing = { params: Promise.resolve({ id: "demo_code_review_0002" }) };
  expect((await getSnapshot(request(), missing)).status).toBe(404);
  expect((await getEmbed(request(), missing)).status).toBe(404);
});

it("cannot delete the bundled example using a bearer token", async () => {
  const response = await DELETE(new NextRequest(`https://portal.example/api/snapshots/${id}`, {
    method: "DELETE", headers: { authorization: "Bearer arbitrary-token" },
  }), context);
  expect(response.status).toBe(404);
  expect((await getSnapshot(request(), context)).status).toBe(200);
});
