import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { hashToken, MAX_PAYLOAD_BYTES, type PublishRequest, type SnapshotPayload } from "@promptbranch/share";
import { POST } from "@/app/api/snapshots/route";
import { getDb, getDeleteTokenHash, getSnapshot } from "@/lib/db";

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function validPayload(overrides: Partial<SnapshotPayload> = {}): PublishRequest {
  return {
    snapshot: {
      formatVersion: 1,
      title: "security-audit",
      description: "Review code for security issues",
      content: "You are a security auditor. Review the following code.",
      tags: ["security", "review"],
      history: [{ version: 1, content: "Initial draft.", changeNote: "first" }],
      publishedAt: "2026-08-25T12:00:00.000Z",
      appVersion: "0.1.0",
      ...overrides,
    },
  };
}

function postSnapshot(body: unknown, ip = nextIp()): Promise<NextResponse> {
  return POST(
    new NextRequest("http://localhost/api/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
  delete process.env.PUBLIC_BASE_URL;
});

describe("POST /api/snapshots", () => {
  it("publishes a valid snapshot: 201 + id/url/deleteToken, row and token hash stored", async () => {
    process.env.PUBLIC_BASE_URL = "http://203.0.113.10:3000";
    const response = await postSnapshot(validPayload());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; url: string; deleteToken: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(body.url).toBe(`http://203.0.113.10:3000/p/${body.id}`);
    expect(body.deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = getSnapshot(getDb(), body.id);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toMatchObject({ title: "security-audit" });
    expect(row!.deleted_at).toBeNull();
    expect(getDeleteTokenHash(getDb(), body.id)).toBe(hashToken(body.deleteToken));
  });

  it("422s with the finding list when the content contains a high-severity secret", async () => {
    const response = await postSnapshot(
      validPayload({ content: `Use this key: sk-${"a".repeat(30)}` }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { findings: Array<{ rule: string; severity: string }> };
    expect(body.findings.some((f) => f.rule === "openai-api-key" && f.severity === "high")).toBe(true);
    // Nothing was stored — assert on row counts, not a specific id, so an
    // insert before the 422 would still trip this.
    const db = getDb();
    const snapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    const tokens = db.prepare("SELECT COUNT(*) AS n FROM delete_tokens").get() as { n: number };
    expect(snapshots.n).toBe(0);
    expect(tokens.n).toBe(0);
  });

  it("allows medium-only findings (warn, not block)", async () => {
    const response = await postSnapshot(
      validPayload({ content: "Reach the internal wiki at https://wiki.corp/runbooks." }),
    );
    expect(response.status).toBe(201);
  });

  it("400s on schema violations and on non-JSON bodies", async () => {
    const bad = await postSnapshot({ snapshot: { formatVersion: 1 } });
    expect(bad.status).toBe(400);
    const notJson = await postSnapshot("this is not json");
    expect(notJson.status).toBe(400);
  });

  it("413s beyond the 256 KB body cap", async () => {
    const response = await postSnapshot("x".repeat(300 * 1024));
    expect(response.status).toBe(413);
  });

  it("413s on an over-cap content-length without reading the body", async () => {
    // A null-body request whose content-length alone exceeds the cap: if the
    // handler buffered the body before checking, it would 400 on the empty
    // body instead of short-circuiting with a 413.
    const response = await POST(
      new NextRequest("http://localhost/api/snapshots", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_PAYLOAD_BYTES + 1),
          "x-forwarded-for": nextIp(),
        },
      }),
    );
    expect(response.status).toBe(413);
  });

  it("422s when a history changeNote contains a high-severity secret", async () => {
    const response = await postSnapshot(
      validPayload({
        history: [{ version: 1, content: "Initial draft.", changeNote: `key: sk-${"a".repeat(30)}` }],
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { findings: Array<{ rule: string }> };
    expect(body.findings.some((f) => f.rule === "openai-api-key")).toBe(true);
  });

  it("429s the 11th publish from one IP within an hour", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      const ok = await postSnapshot(validPayload(), ip);
      expect(ok.status).toBe(201);
    }
    const blocked = await postSnapshot(validPayload(), ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("stores parent_id when parentId references an existing snapshot", async () => {
    const parent = await postSnapshot(validPayload());
    const { id: parentSnapshotId } = (await parent.json()) as { id: string };
    const child = await postSnapshot(validPayload({ parentId: parentSnapshotId }));
    expect(child.status).toBe(201);
    const { id: childId } = (await child.json()) as { id: string };
    expect(getSnapshot(getDb(), childId)!.parent_id).toBe(parentSnapshotId);
  });

  it("400s when parentId does not reference an existing snapshot", async () => {
    // Valid id format (21 chars) that simply isn't in the database.
    const response = await postSnapshot(validPayload({ parentId: "does-not-exist-000000" }));
    expect(response.status).toBe(400);
    const db = getDb();
    const snapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    expect(snapshots.n).toBe(0);
  });
});
