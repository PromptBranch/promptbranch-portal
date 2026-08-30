import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generateDeleteToken, hashToken, snapshotResponseSchema } from "@promptbranch/share";
import { DELETE, GET } from "@/app/api/snapshots/[id]/route";
import { getDb, getSnapshot, insertDeleteToken, insertSnapshot } from "@/lib/db";

const ID = "V1StGXR8_Z5jdHi6B-myT";
let ipCounter = 1000;
function nextIp(): string {
  ipCounter += 1;
  return `10.98.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

const SNAPSHOT = {
  formatVersion: 1,
  title: "security-audit",
  content: "You are a security auditor.",
  tags: ["security"],
  publishedAt: "2026-08-25T12:00:00.000Z",
};

function seedSnapshot(): string {
  const db = getDb();
  insertSnapshot(db, {
    id: ID,
    payload: JSON.stringify(SNAPSHOT),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: SNAPSHOT.publishedAt,
    publisherIpHash: "b".repeat(64),
  });
  const token = generateDeleteToken();
  insertDeleteToken(db, ID, hashToken(token));
  return token;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function getSnapshotRequest(id: string, ip = nextIp()) {
  return GET(
    new NextRequest(`http://localhost/api/snapshots/${id}`, { headers: { "x-forwarded-for": ip } }),
    ctx(id),
  );
}

function deleteSnapshotRequest(id: string, token?: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/snapshots/${id}`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    ctx(id),
  );
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
  delete process.env.PUBLIC_BASE_URL;
});

describe("GET /api/snapshots/[id]", () => {
  it("200s with a schema-valid response for a live snapshot", async () => {
    seedSnapshot();
    const response = await getSnapshotRequest(ID);
    expect(response.status).toBe(200);
    const parsed = snapshotResponseSchema.parse(await response.json());
    expect(parsed.id).toBe(ID);
    expect(parsed.url).toBe(`http://localhost:3000/p/${ID}`);
    expect(parsed.snapshot).toEqual(SNAPSHOT);
  });

  it("404s unknown ids and 410s soft-deleted snapshots", async () => {
    expect((await getSnapshotRequest("missingmissingmissi")).status).toBe(404);
    const token = seedSnapshot();
    expect((await deleteSnapshotRequest(ID, token)).status).toBe(200);
    expect((await getSnapshotRequest(ID)).status).toBe(410);
  });
});

describe("DELETE /api/snapshots/[id]", () => {
  it("401s without a bearer token", async () => {
    seedSnapshot();
    expect((await deleteSnapshotRequest(ID)).status).toBe(401);
  });

  it("403s with a wrong token", async () => {
    seedSnapshot();
    expect((await deleteSnapshotRequest(ID, generateDeleteToken())).status).toBe(403);
  });

  it("404s unknown snapshots", async () => {
    seedSnapshot();
    expect((await deleteSnapshotRequest("missingmissingmissi", generateDeleteToken())).status).toBe(404);
  });

  it("soft-deletes with the right token and is idempotent", async () => {
    const token = seedSnapshot();
    expect((await deleteSnapshotRequest(ID, token)).status).toBe(200);
    const row = getSnapshot(getDb(), ID);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    // Second delete with the same token still succeeds — no information leak
    // about whether it was already deleted.
    expect((await deleteSnapshotRequest(ID, token)).status).toBe(200);
  });
});
