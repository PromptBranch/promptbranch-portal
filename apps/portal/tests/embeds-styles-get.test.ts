import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getEmbed } from "@/app/api/embeds/[id]/route";
import { GET as getStyles } from "@/app/api/embeds/[id]/styles.css/route";
import { getDb, insertSnapshot } from "@/lib/db";

const ID = "V1StGXR8_Z5jdHi6B-myT";
const PUBLISHED_AT = "2026-08-25T12:00:00.000Z";
let ipCounter = 2400;

function nextIp(): string {
  ipCounter += 1;
  return `10.96.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function seedSnapshot(): void {
  insertSnapshot(getDb(), {
    id: ID,
    payload: JSON.stringify({
      formatVersion: 1,
      title: "Syntax colors",
      content: "# Review\n\n**Bold** and `inline`.\n\n```ts\nconst answer = 42;\n```",
      tags: [],
      history: [],
      publishedAt: PUBLISHED_AT,
    }),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: PUBLISHED_AT,
    publisherIpHash: "b".repeat(64),
  });
}

function request(path: string, ip = nextIp()) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

const context = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-embed-styles-test-"));
  process.env.PUBLIC_BASE_URL = "https://prompts.example";
});

describe("GET /api/embeds/[id]/styles.css", () => {
  it("serves CSP-compatible Shiki token rules for the classes in the embed response", async () => {
    seedSnapshot();
    const embedResponse = await getEmbed(request(`/api/embeds/${ID}`), context);
    const embed = await embedResponse.json();
    const stylesResponse = await getStyles(request(`/api/embeds/${ID}/styles.css`), context);
    const styles = await stylesResponse.text();

    expect(stylesResponse.status).toBe(200);
    expect(stylesResponse.headers.get("content-type")).toMatch(/^text\/css/);
    expect(stylesResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(stylesResponse.headers.get("cache-control")).toBe("no-store");
    expect(stylesResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(embed.contentHtml).not.toContain('style="');
    expect(embed.sourceHtml).not.toContain('style="');

    const tokenClass = (String(embed.sourceHtml).match(/pb-shiki-[a-f0-9]{12}/) ?? [])[0];
    expect(tokenClass).toBeTruthy();
    expect(styles).toContain(`.${tokenClass}`);
    expect(styles).toMatch(/--shiki-(?:light|dark):#[a-f0-9]{3,8}/i);
  });

  it("does not serve style data for a revoked snapshot", async () => {
    seedSnapshot();
    getDb().prepare("UPDATE snapshots SET deleted_at = ? WHERE id = ?").run(PUBLISHED_AT, ID);

    const response = await getStyles(request(`/api/embeds/${ID}/styles.css`), context);
    expect(response.status).toBe(410);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
