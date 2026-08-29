import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/reports/route";
import { getDb, insertSnapshot, listReports } from "@/lib/db";

const ID = "V1StGXR8_Z5jdHi6B-myT";
let ipCounter = 5000;
function nextIp(): string {
  ipCounter += 1;
  return `10.97.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function seed(): void {
  insertSnapshot(getDb(), {
    id: ID,
    payload: JSON.stringify({ formatVersion: 1, title: "t" }),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: "2026-08-25T12:00:00.000Z",
    publisherIpHash: "b".repeat(64),
  });
}

function postReport(body: unknown, ip = nextIp()) {
  return POST(
    new NextRequest("http://localhost/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
});

describe("POST /api/reports", () => {
  it("201s and stores the report", async () => {
    seed();
    const response = await postReport({ snapshotId: ID, reason: "contains my private data" });
    expect(response.status).toBe(201);
    const reports = listReports(getDb());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ snapshot_id: ID, reason: "contains my private data" });
  });

  it("404s reports about unknown snapshots", async () => {
    seed();
    expect((await postReport({ snapshotId: "missingmissingmissi", reason: "spam" })).status).toBe(404);
  });

  it("400s on empty or over-long reasons", async () => {
    seed();
    expect((await postReport({ snapshotId: ID, reason: "" })).status).toBe(400);
    expect((await postReport({ snapshotId: ID, reason: "x".repeat(1001) })).status).toBe(400);
  });

  it("429s the 6th report from one IP within an hour", async () => {
    seed();
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      expect((await postReport({ snapshotId: ID, reason: `report ${i}` }, ip)).status).toBe(201);
    }
    expect((await postReport({ snapshotId: ID, reason: "one too many" }, ip)).status).toBe(429);
  });
});
