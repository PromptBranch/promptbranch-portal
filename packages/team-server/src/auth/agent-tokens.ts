import { randomUUID } from "node:crypto";
import type { Pool } from "../db.js";
import { withWorkspaceTransaction } from "../tx.js";
import { teamError } from "../errors.js";
import { randomTokenUrlSafe, sha256Bytes, secretsMatch } from "./crypto.js";
import type { Principal, Scope } from "./principal.js";
import { principalId } from "./principal.js";
import { findWorkspaceReceipt, persistWorkspaceReceipt, requestHash } from "../commands/receipts.js";
import { appendAudit } from "../domain/audit.js";
import { SCOPE_VALUES } from "../commands/operations.js";

/**
 * Scoped agent capabilities (contract §C1/C5): opaque `pbt_` tokens owned
 * by a member — never an independent role. Format
 * `pbt_<publicTokenId>.<32-random-byte-base64url-secret>`; only the sha256
 * of the secret is stored. The secret is shown exactly once: an idempotent
 * retry after a lost first response replays the receipt with
 * secretAvailable:false. Effective access is ALWAYS the intersection of the
 * token's scopes and the owner's CURRENT membership (checked on every
 * request, incl. expiry, revocation and generation binding).
 */

const TOKEN_PATTERN = /^pbt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
export const MAX_ACTIVE_TOKENS_PER_MEMBER = 20;
const ROLE_RANK = { viewer: 1, contributor: 2, maintainer: 3, owner: 4 } as const;
type Role = keyof typeof ROLE_RANK;

export interface MintAgentTokenInput {
  commandId: string;
  name: string;
  scopes: Scope[];
  expiresInDays?: number;
}

export interface MintedAgentToken {
  tokenId: string;
  /** Raw token — present exactly once, on the creating response only. */
  token?: string;
  expiresAt: string;
  secretAvailable: boolean;
}

export async function createAgentToken(
  pool: Pool,
  principal: Principal,
  workspaceId: string,
  epoch: string,
  input: MintAgentTokenInput,
): Promise<MintedAgentToken> {
  if (principal.kind !== "human") {
    throw teamError("ROLE_FORBIDDEN", "Agent tokens are minted by humans");
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) {
    throw teamError("VALIDATION_FAILED", "Token name must be 1-100 characters after trimming");
  }
  const expiresInDays = input.expiresInDays ?? 30;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw teamError("VALIDATION_FAILED", "expiresInDays must be an integer between 1 and 90");
  }
  const requested = new Set(input.scopes);
  for (const scope of requested) {
    if (!SCOPE_VALUES.includes(scope)) {
      throw teamError("VALIDATION_FAILED", `Unknown scope: ${String(scope)}`);
    }
  }
  // Every token carries catalog:read (contract §C1).
  const scopes = [...new Set([...requested, "catalog:read" as Scope])].sort();

  return withWorkspaceTransaction(pool, { workspaceId, commandId: input.commandId }, async ({ tx, workspace }) => {
    if (!epoch || workspace.server_epoch !== epoch) {
      throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; retry with the current epoch");
    }
    const membership = await tx.query<{ role: Role; generation: string }>(
      "SELECT role, generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [workspaceId, principal.userId],
    );
    const member = membership.rows[0];
    if (!member) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
    // A viewer cannot mint write scopes (read-only capabilities only).
    if (ROLE_RANK[member.role] < ROLE_RANK.contributor && scopes.some((s) => s !== "catalog:read")) {
      throw teamError("ROLE_FORBIDDEN", "Viewers may only mint read-only agent tokens");
    }

    const hash = requestHash({
      principalId: principalId(principal),
      workspaceId,
      membershipGeneration: member.generation,
      commandId: input.commandId,
      operation: { kind: "agentToken.create", name, scopes, expiresInDays },
    });
    const existing = await findWorkspaceReceipt(tx, {
      workspaceId,
      principalId: principalId(principal),
      commandId: input.commandId,
    });
    if (existing) {
      const stored = await tx.query<{ request_hash: Buffer }>(
        "SELECT request_hash FROM team_command_receipts WHERE workspace_id = $1 AND principal_id = $2 AND command_id = $3",
        [workspaceId, principalId(principal), input.commandId],
      );
      if (!stored.rows[0] || !stored.rows[0].request_hash.equals(hash)) {
        throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
      }
      // The secret cannot be re-derived: replay reports its absence.
      const row = await tx.query<{ expires_at: Date }>(
        "SELECT expires_at FROM team_agent_tokens WHERE id = $1",
        [existing.resultJson.id],
      );
      return {
        tokenId: existing.resultJson.id,
        expiresAt: (row.rows[0]?.expires_at ?? new Date()).toISOString(),
        secretAvailable: false,
      };
    }

    const active = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM team_agent_tokens
        WHERE workspace_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [workspaceId, principal.userId],
    );
    if (Number(active.rows[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS_PER_MEMBER) {
      throw teamError("QUOTA_EXCEEDED", `Active agent token quota reached (${MAX_ACTIVE_TOKENS_PER_MEMBER})`);
    }

    const tokenId = randomUUID();
    const secret = randomTokenUrlSafe(32);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    await tx.query(
      `INSERT INTO team_agent_tokens (workspace_id, id, owner_user_id, name, secret_hash, scopes, membership_generation, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [workspaceId, tokenId, principal.userId, name, sha256Bytes(secret), scopes, member.generation, expiresAt],
    );
    await appendAudit(tx, {
      workspaceId,
      actor: principal,
      action: "agentToken.create",
      resourceType: "agentToken",
      resourceId: tokenId,
      metadata: { scopes },
    });
    await persistWorkspaceReceipt(
      tx,
      { workspaceId, principalId: principalId(principal), commandId: input.commandId, requestHash: hash },
      { kind: "agentToken", id: tokenId },
    );
    return { tokenId, token: `pbt_${tokenId}.${secret}`, expiresAt: expiresAt.toISOString(), secretAvailable: true };
  });
}

export interface AgentTokenSummary {
  id: string;
  name: string;
  scopes: Scope[];
  ownerUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Own metadata by default; the workspace owner may list everyone's. */
export async function listAgentTokens(
  pool: Pool,
  principal: Principal,
  workspaceId: string,
): Promise<AgentTokenSummary[]> {
  if (principal.kind !== "human") {
    throw teamError("ROLE_FORBIDDEN", "Token metadata is managed by humans");
  }
  const membership = await pool.query<{ role: Role }>(
    "SELECT role FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [workspaceId, principal.userId],
  );
  const member = membership.rows[0];
  if (!member) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
  const all = member.role === "owner";
  const result = await pool.query<{
    id: string;
    name: string;
    scopes: Scope[];
    owner_user_id: string;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, scopes, owner_user_id, created_at, expires_at, revoked_at
       FROM team_agent_tokens
      WHERE workspace_id = $1 ${all ? "" : "AND owner_user_id = $2"}
      ORDER BY created_at DESC, id
      LIMIT 200`,
    all ? [workspaceId] : [workspaceId, principal.userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  }));
}

/** Revocation is final (a rejoin never revives a token — generation binds). */
export async function revokeAgentToken(
  pool: Pool,
  principal: Principal,
  workspaceId: string,
  tokenId: string,
  epoch: string,
): Promise<void> {
  if (principal.kind !== "human") {
    throw teamError("ROLE_FORBIDDEN", "Agent tokens are revoked by humans");
  }
  await withWorkspaceTransaction(pool, { workspaceId, commandId: `revoke-${tokenId}` }, async ({ tx, workspace }) => {
    if (workspace.server_epoch !== epoch) {
      throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; retry with the current epoch");
    }
    const membership = await tx.query<{ role: Role }>(
      "SELECT role FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [workspaceId, principal.userId],
    );
    const member = membership.rows[0];
    if (!member) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
    const updated = await tx.query<{ owner_user_id: string }>(
      `UPDATE team_agent_tokens SET revoked_at = now()
        WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
          AND ($3 OR owner_user_id = $4)
        RETURNING owner_user_id`,
      [workspaceId, tokenId, member.role === "owner", principal.userId],
    );
    if (!updated.rows[0]) {
      const exists = await tx.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM team_agent_tokens WHERE workspace_id = $1 AND id = $2",
        [workspaceId, tokenId],
      );
      if (!exists.rows[0]) throw teamError("NOT_FOUND", "Agent token not found");
      // Already revoked, or not owned by the caller and caller is not the
      // owner: idempotent success only for the already-revoked own token.
      if (exists.rows[0].owner_user_id === principal.userId || member.role === "owner") return;
      throw teamError("NOT_FOUND", "Agent token not found");
    }
    await appendAudit(tx, {
      workspaceId,
      actor: principal,
      action: "agentToken.revoke",
      resourceType: "agentToken",
      resourceId: tokenId,
    });
  });
}

export interface ResolvedAgent {
  principal: { kind: "agent"; userId: string; tokenId: string; scopes: Scope[] };
  ownerUserId: string;
  role: Role;
  generation: string;
  workspaceId: string;
  expiresAt: Date;
}

/**
 * Parses and fully validates a `pbt_` bearer against CURRENT state: secret
 * hash compared in constant time, expiry, revocation, owner account status,
 * workspace binding and the generation invariant (a rotation that did not
 * revoke the row still invalidates it — fail closed).
 */
export async function resolveAgentBearer(pool: Pool, bearer: string, workspaceId?: string): Promise<ResolvedAgent> {
  const match = TOKEN_PATTERN.exec(bearer);
  if (!match) throw teamError("UNAUTHENTICATED", "Invalid agent token");
  const tokenId = match[1] ?? "";
  const secret = match[2] ?? "";
  const row = await pool
    .query<{
      id: string;
      workspace_id: string;
      owner_user_id: string;
      secret_hash: Buffer;
      scopes: Scope[];
      membership_generation: string;
      expires_at: Date;
      revoked_at: Date | null;
      disabled_at: Date | null;
      deleted_at: Date | null;
      role: Role;
      generation: string;
      removed_at: Date | null;
    }>(
      `SELECT t.id, t.workspace_id, t.owner_user_id, t.secret_hash, t.scopes,
              t.membership_generation, t.expires_at, t.revoked_at,
              u.disabled_at, u.deleted_at,
              m.role, m.generation, m.removed_at
         FROM team_agent_tokens t
         JOIN team_users u ON u.id = t.owner_user_id
         LEFT JOIN team_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.owner_user_id
        WHERE t.id = $1`,
      [tokenId],
    );
  const token = row.rows[0];
  if (!token || !secretsMatch(token.secret_hash, sha256Bytes(secret))) {
    throw teamError("UNAUTHENTICATED", "Invalid agent token");
  }
  if (token.revoked_at || token.expires_at.getTime() <= Date.now()) {
    throw teamError("UNAUTHENTICATED", "Agent token is no longer valid");
  }
  if (token.disabled_at || token.deleted_at || token.removed_at || !token.role) {
    throw teamError("UNAUTHENTICATED", "Agent token is no longer valid");
  }
  // Generation binding: membership rotations revoke tokens transactionally
  // (P3); an unrevoked-but-stale row still fails closed here.
  if (token.generation !== token.membership_generation) {
    throw teamError("UNAUTHENTICATED", "Agent token is no longer valid");
  }
  if (workspaceId !== undefined && token.workspace_id !== workspaceId) {
    throw teamError("WORKSPACE_FORBIDDEN", "Agent token belongs to another workspace");
  }
  return {
    principal: { kind: "agent", userId: token.owner_user_id, tokenId: token.id, scopes: token.scopes },
    ownerUserId: token.owner_user_id,
    role: token.role,
    generation: token.generation,
    workspaceId: token.workspace_id,
    expiresAt: token.expires_at,
  };
}
