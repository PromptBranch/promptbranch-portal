import { createHash } from "node:crypto";
import type { Pool } from "../db.js";
import { withTransaction } from "../db.js";
import { teamError } from "../errors.js";
import type { CursorSigner } from "../sync/cursors.js";
import { consumeRateBucket } from "./rate.js";

/**
 * Owner-authorized workspace export (plan P9): a portability snapshot in
 * NDJSON form — NOT a live restore/import API. Materialized under the
 * workspace row lock in repeatable read (same pattern as the C7 bootstrap)
 * so the stream is consistent; every page rechecks that the caller is STILL
 * the owner. Contains domain content only — never sessions, token hashes,
 * invitation secrets, receipts, jobs or rate-bucket internals. Each record
 * carries the sha256 of its canonical jsonb text so recipients can verify
 * integrity; jsonb key ordering makes the digest stable.
 */

export const EXPORTS_PER_HOUR = 3;
const EXPORT_TTL_MS = 10 * 60_000;

export interface ExportManifest {
  format: "promptbranch-team-export/ndjson";
  schemaVersion: 1;
  workspaceId: string;
  generatedAt: string;
  highWater: string;
  counts: Record<string, number>;
}

export interface StartedExport {
  exportId: string;
  manifest: ExportManifest;
  expiresAt: string;
}

// Domain content tables, exported as to_jsonb minus the workspace column.
// Audit stays internal (metadata-only); identity/session/token/invitation/
// job/rate-bucket tables never enter an export.
const EXPORT_UNION = `
  SELECT 'prompt' AS type, x.id::text AS id, to_jsonb(x) - 'workspace_id' AS data FROM team_prompts x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'revision', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_revisions x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'publication', x.revision_id::text, to_jsonb(x) - 'workspace_id' FROM team_publications x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'tag', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_tags x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'collection', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_collections x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'prompt_tag', x.prompt_id::text || ':' || x.tag_id::text, to_jsonb(x) - 'workspace_id' FROM team_prompt_tags x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'collection_prompt', x.collection_id::text || ':' || x.prompt_id::text, to_jsonb(x) - 'workspace_id' FROM team_collection_prompts x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'proposal', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_proposals x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'review', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_reviews x WHERE x.workspace_id = $1
  UNION ALL
  SELECT 'comment', x.id::text, to_jsonb(x) - 'workspace_id' FROM team_comments x WHERE x.workspace_id = $1`;

export async function startExport(pool: Pool, input: { workspaceId: string; userId: string }): Promise<StartedExport> {
  return withTransaction(pool, async (tx) => {
    await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const locked = await tx.query<{ id: string; server_epoch: string; next_catalog_seq: string; deleted_at: Date | null }>(
      "SELECT id, server_epoch, next_catalog_seq::text, deleted_at FROM team_workspaces WHERE id = $1 FOR UPDATE",
      [input.workspaceId],
    );
    const workspace = locked.rows[0];
    if (!workspace || workspace.deleted_at) throw teamError("NOT_FOUND", "Workspace not found");

    const membership = await tx.query<{ role: string }>(
      `SELECT m.role FROM team_memberships m
         JOIN team_users u ON u.id = m.user_id AND u.disabled_at IS NULL AND u.deleted_at IS NULL
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL`,
      [input.workspaceId, input.userId],
    );
    if (membership.rows[0]?.role !== "owner") {
      throw teamError("ROLE_FORBIDDEN", "Only the workspace owner can export");
    }

    await consumeRateBucket(tx, `export:${input.workspaceId}`, EXPORTS_PER_HOUR, 3_600_000);

    // One active export per owner: a fresh start supersedes the previous.
    await tx.query(
      `DELETE FROM team_exports WHERE workspace_id = $1 AND principal_user_id = $2`,
      [input.workspaceId, input.userId],
    );

    const highWater = String(Number(workspace.next_catalog_seq) - 1);
    const exportId = (await tx.query<{ id: string }>(
      `INSERT INTO team_exports (workspace_id, principal_user_id, high_water, manifest_json, expires_at)
       VALUES ($1, $2, $3, '{}'::jsonb, now() + interval '10 minutes')
       RETURNING id`,
      [input.workspaceId, input.userId, Number(highWater)],
    )).rows[0]!.id;

    await tx.query(
      `INSERT INTO team_export_rows (export_id, ordinal, record_json)
       SELECT $1,
              row_number() OVER (ORDER BY type, id) - 1,
              jsonb_build_object('type', u.type, 'id', u.id, 'sha256', encode(sha256(convert_to(u.data::text, 'UTF8')), 'hex'), 'data', u.data)
         FROM (${EXPORT_UNION.replace(/\$1\b/g, "$2")}) u`,
      [exportId, input.workspaceId],
    );

    const counts: Record<string, number> = {};
    for (const row of (await tx.query<{ type: string; count: string }>(
      "SELECT record_json->>'type' AS type, count(*)::text AS count FROM team_export_rows WHERE export_id = $1 GROUP BY 1 ORDER BY 1",
      [exportId],
    )).rows) {
      counts[row.type] = Number(row.count);
    }
    const manifest: ExportManifest = {
      format: "promptbranch-team-export/ndjson",
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      generatedAt: new Date().toISOString(),
      highWater,
      counts,
    };
    await tx.query("UPDATE team_exports SET manifest_json = $2 WHERE id = $1", [exportId, JSON.stringify(manifest)]);
    const expires = (await tx.query<{ expires_at: Date }>("SELECT expires_at FROM team_exports WHERE id = $1", [exportId])).rows[0]!;
    return { exportId, manifest, expiresAt: expires.expires_at.toISOString() };
  });
}

export interface ExportPage {
  exportId: string;
  /** Pre-rendered NDJSON lines (canonical jsonb text of each record). */
  records: string[];
  nextPageToken: string | null;
}

export async function readExportPage(
  pool: Pool,
  input: { workspaceId: string; userId: string; exportId: string; pageToken?: string; signer: CursorSigner; limit?: number },
): Promise<ExportPage> {
  // Access is rechecked on EVERY page: ownership can be lost mid-download.
  const current = await pool.query<{ role: string }>(
    `SELECT m.role FROM team_memberships m
       JOIN team_users u ON u.id = m.user_id AND u.disabled_at IS NULL AND u.deleted_at IS NULL
       JOIN team_workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
      WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL`,
    [input.workspaceId, input.userId],
  );
  if (current.rows[0]?.role !== "owner") {
    throw teamError("ROLE_FORBIDDEN", "Only the workspace owner can export");
  }

  let offset = 0;
  if (input.pageToken) {
    const claims = input.signer.verify<{ e: string; o: number }>(input.pageToken);
    if (!claims || claims.e !== input.exportId || !Number.isInteger(claims.o) || claims.o < 0) {
      throw teamError("VALIDATION_FAILED", "Invalid page token");
    }
    offset = claims.o;
  }

  const found = await pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM team_exports WHERE id = $1 AND workspace_id = $2",
    [input.exportId, input.workspaceId],
  );
  const row = found.rows[0];
  if (!row) throw teamError("NOT_FOUND", "Export not found");
  if (row.expires_at.getTime() <= Date.now()) throw teamError("NOT_FOUND", "Export expired; start a new one");

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const page = await pool.query<{ record_json: unknown }>(
    "SELECT record_json FROM team_export_rows WHERE export_id = $1 AND ordinal >= $2 ORDER BY ordinal LIMIT $3",
    [input.exportId, offset, limit],
  );
  const hasMore = page.rows.length === limit;
  return {
    exportId: input.exportId,
    records: page.rows.map((r) => JSON.stringify(r.record_json)),
    nextPageToken: hasMore ? input.signer.sign({ e: input.exportId, o: offset + limit }) : null,
  };
}

/**
 * Reproduces PostgreSQL's jsonb canonical text: object keys sorted by utf-8
 * byte length, then bytewise; `": "` between keys and values and `", "`
 * between pairs (exactly how jsonb renders as text). Scalars round-trip
 * unchanged through JSON.parse/stringify (our records carry strings,
 * integers, booleans and nulls only), so this matches `data::text` on the
 * server.
 */
function canonicalJsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonbText).join(", ")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => {
    const aBytes = Buffer.byteLength(a, "utf8");
    const bBytes = Buffer.byteLength(b, "utf8");
    return aBytes - bBytes || Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  });
  const obj = value as Record<string, unknown>;
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${canonicalJsonbText(obj[key])}`).join(", ")}}`;
}

/** Verifies a downloaded record line against its embedded sha256. */
export function verifyExportRecord(line: string): boolean {
  try {
    const record = JSON.parse(line) as { sha256?: string; data?: unknown };
    return (
      typeof record.sha256 === "string" &&
      record.sha256 === createHash("sha256").update(canonicalJsonbText(record.data)).digest("hex")
    );
  } catch {
    return false;
  }
}
