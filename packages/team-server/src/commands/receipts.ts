import { createHash } from "node:crypto";
import type { PoolClient } from "../db.js";
import { teamError } from "../errors.js";

/**
 * Command idempotency receipts (contract §C6). Key: (workspaceId or user,
 * principalId, commandId). The stored request hash covers the COMPLETE
 * command — envelope and membership generation — so replaying the same ID
 * with a different payload is COMMAND_ID_REUSED, never a silent second
 * mutation. Only successful mutations produce receipts; failures consume no
 * command ID.
 */

/** Stable stringify: sorted object keys, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(parts: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalJson(parts), "utf8").digest();
}

export interface StoredReceipt {
  resultJson: {
    kind: string;
    id: string;
    entityVersion?: number;
  };
  committedAt: Date;
}

/** Workspace-scoped receipt lookup; undefined when the ID was never used. */
export async function findWorkspaceReceipt(
  tx: PoolClient,
  key: { workspaceId: string; principalId: string; commandId: string },
): Promise<StoredReceipt | undefined> {
  const result = await tx.query<{ result_json: StoredReceipt["resultJson"]; committed_at: Date }>(
    "SELECT result_json, committed_at FROM team_command_receipts WHERE workspace_id = $1 AND principal_id = $2 AND command_id = $3",
    [key.workspaceId, key.principalId, key.commandId],
  );
  const row = result.rows[0];
  return row ? { resultJson: row.result_json, committedAt: row.committed_at } : undefined;
}

/** Persists a receipt; a conflicting (same key, different hash) insert fails the transaction. */
export async function persistWorkspaceReceipt(
  tx: PoolClient,
  key: { workspaceId: string; principalId: string; commandId: string; requestHash: Buffer },
  result: StoredReceipt["resultJson"],
): Promise<Date> {
  const insert = await tx.query<{ committed_at: Date }>(
    `INSERT INTO team_command_receipts (workspace_id, principal_id, command_id, request_hash, result_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, principal_id, command_id) DO NOTHING
     RETURNING committed_at`,
    [key.workspaceId, key.principalId, key.commandId, key.requestHash, JSON.stringify(result)],
  );
  if (insert.rows[0]) return insert.rows[0].committed_at;
  // Key exists from an earlier command: identical hash replays, anything
  // else is a reused ID carrying a different mutation.
  const stored = await tx.query<{ request_hash: Buffer }>(
    "SELECT request_hash FROM team_command_receipts WHERE workspace_id = $1 AND principal_id = $2 AND command_id = $3",
    [key.workspaceId, key.principalId, key.commandId],
  );
  if (!stored.rows[0] || !stored.rows[0].request_hash.equals(key.requestHash)) {
    throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
  }
  const existing = await findWorkspaceReceipt(tx, key);
  if (!existing) throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
  return existing.committedAt;
}

/** User-scoped receipts: workspace creation and invitation acceptance. */
export async function findUserReceipt(
  tx: PoolClient,
  key: { userId: string; commandId: string },
): Promise<StoredReceipt | undefined> {
  const result = await tx.query<{ result_json: StoredReceipt["resultJson"]; committed_at: Date }>(
    "SELECT result_json, committed_at FROM team_user_receipts WHERE user_id = $1 AND command_id = $2",
    [key.userId, key.commandId],
  );
  const row = result.rows[0];
  return row ? { resultJson: row.result_json, committedAt: row.committed_at } : undefined;
}

export async function persistUserReceipt(
  tx: PoolClient,
  key: { userId: string; commandId: string; requestHash: Buffer },
  result: StoredReceipt["resultJson"],
): Promise<Date> {
  const insert = await tx.query<{ committed_at: Date }>(
    `INSERT INTO team_user_receipts (user_id, command_id, request_hash, result_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, command_id) DO NOTHING
     RETURNING committed_at`,
    [key.userId, key.commandId, key.requestHash, JSON.stringify(result)],
  );
  if (insert.rows[0]) return insert.rows[0].committed_at;
  const stored = await tx.query<{ request_hash: Buffer }>(
    "SELECT request_hash FROM team_user_receipts WHERE user_id = $1 AND command_id = $2",
    [key.userId, key.commandId],
  );
  if (!stored.rows[0] || !stored.rows[0].request_hash.equals(key.requestHash)) {
    throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
  }
  const existing = await findUserReceipt(tx, key);
  if (!existing) throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
  return existing.committedAt;
}
