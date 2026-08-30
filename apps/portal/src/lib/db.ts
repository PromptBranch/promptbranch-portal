import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "@/lib/env";

export interface SnapshotRow {
  id: string;
  payload: string;
  content_hash: string;
  parent_id: string | null;
  published_at: string;
  publisher_ip_hash: string;
  deleted_at: string | null;
}

export interface NewSnapshot {
  id: string;
  payload: string;
  contentHash: string;
  parentId: string | null;
  publishedAt: string;
  publisherIpHash: string;
}

export interface NewReport {
  snapshotId: string;
  reason: string;
  createdAt: string;
  reporterIpHash: string;
}

export interface ReportRow {
  id: number;
  snapshot_id: string;
  reason: string;
  created_at: string;
  reporter_ip_hash: string;
}

/**
 * Snapshots are immutable and append-mostly — SQLite's happy path. Columns
 * stay Postgres-compatible (no SQLite-only types) in case a later phase
 * outgrows the single-container deployment.
 */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parent_id TEXT,
      published_at TEXT NOT NULL,
      publisher_ip_hash TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS delete_tokens (
      snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id),
      token_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reporter_ip_hash TEXT NOT NULL
    );
  `);
  return db;
}

let cached: { dir: string; db: Database.Database } | null = null;

/** Process-wide handle; reopens when DATA_DIR changes so tests can isolate. */
export function getDb(): Database.Database {
  const dir = getEnv().DATA_DIR;
  if (!cached || cached.dir !== dir) {
    mkdirSync(dir, { recursive: true });
    cached = { dir, db: openDatabase(join(dir, "portal.db")) };
  }
  return cached.db;
}

export function insertSnapshot(db: Database.Database, snapshot: NewSnapshot): void {
  db.prepare(
    `INSERT INTO snapshots (id, payload, content_hash, parent_id, published_at, publisher_ip_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.id,
    snapshot.payload,
    snapshot.contentHash,
    snapshot.parentId,
    snapshot.publishedAt,
    snapshot.publisherIpHash,
  );
}

export function getSnapshot(db: Database.Database, id: string): SnapshotRow | undefined {
  return db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
}

/** Soft delete keeps lineage intact while removing content from view. */
export function softDeleteSnapshot(db: Database.Database, id: string, deletedAt: string): void {
  db.prepare("UPDATE snapshots SET deleted_at = ? WHERE id = ?").run(deletedAt, id);
}

export function insertDeleteToken(db: Database.Database, snapshotId: string, tokenHash: string): void {
  db.prepare("INSERT INTO delete_tokens (snapshot_id, token_hash) VALUES (?, ?)").run(snapshotId, tokenHash);
}

export function getDeleteTokenHash(db: Database.Database, snapshotId: string): string | undefined {
  const row = db.prepare("SELECT token_hash FROM delete_tokens WHERE snapshot_id = ?").get(snapshotId) as
    | { token_hash: string }
    | undefined;
  return row?.token_hash;
}

export function insertReport(db: Database.Database, report: NewReport): number {
  const result = db
    .prepare("INSERT INTO reports (snapshot_id, reason, created_at, reporter_ip_hash) VALUES (?, ?, ?, ?)")
    .run(report.snapshotId, report.reason, report.createdAt, report.reporterIpHash);
  return Number(result.lastInsertRowid);
}

export function listReports(db: Database.Database): ReportRow[] {
  return db.prepare("SELECT * FROM reports ORDER BY id").all() as ReportRow[];
}
