import { describe, expect, it } from "vitest";
import {
  getDeleteTokenHash,
  getSnapshot,
  insertDeleteToken,
  insertReport,
  insertSnapshot,
  listReports,
  openDatabase,
  softDeleteSnapshot,
  type NewSnapshot,
} from "@/lib/db";

function seed(overrides: Partial<NewSnapshot> = {}): NewSnapshot {
  return {
    id: "V1StGXR8_Z5jdHi6B-myT",
    payload: JSON.stringify({ formatVersion: 1, title: "t" }),
    contentHash: "a".repeat(64),
    parentId: null,
    publishedAt: "2026-08-25T12:00:00.000Z",
    publisherIpHash: "b".repeat(64),
    ...overrides,
  };
}

describe("storage layer", () => {
  it("creates all three tables on open", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(["delete_tokens", "reports", "snapshots", "sqlite_sequence"]);
  });

  it("round-trips a snapshot and soft-deletes it", () => {
    const db = openDatabase(":memory:");
    insertSnapshot(db, seed());
    const live = getSnapshot(db, seed().id);
    expect(live?.id).toBe(seed().id);
    expect(live?.deleted_at).toBeNull();
    expect(live?.parent_id).toBeNull();

    softDeleteSnapshot(db, seed().id, "2026-08-25T13:00:00.000Z");
    const deleted = getSnapshot(db, seed().id);
    expect(deleted?.deleted_at).toBe("2026-08-25T13:00:00.000Z");
    expect(getSnapshot(db, "missing")).toBeUndefined();
  });

  it("stores and retrieves delete token hashes", () => {
    const db = openDatabase(":memory:");
    insertSnapshot(db, seed());
    insertDeleteToken(db, seed().id, "c".repeat(64));
    expect(getDeleteTokenHash(db, seed().id)).toBe("c".repeat(64));
    expect(getDeleteTokenHash(db, "missing")).toBeUndefined();
  });

  it("stores reports with autoincrement ids", () => {
    const db = openDatabase(":memory:");
    insertSnapshot(db, seed());
    const first = insertReport(db, {
      snapshotId: seed().id,
      reason: "contains private data",
      createdAt: "2026-08-25T14:00:00.000Z",
      reporterIpHash: "d".repeat(64),
    });
    expect(first).toBe(1);
    const reports = listReports(db);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ snapshot_id: seed().id, reason: "contains private data" });
  });

  it("keeps a parent_id link when provided", () => {
    const db = openDatabase(":memory:");
    insertSnapshot(db, seed({ id: "parentparentparent01" }));
    insertSnapshot(db, seed({ parentId: "parentparentparent01" }));
    expect(getSnapshot(db, seed().id)?.parent_id).toBe("parentparentparent01");
  });
});
