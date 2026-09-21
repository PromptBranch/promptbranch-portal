import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../db.js";
import { withTransaction } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import type { TeamRole } from "../commands/operations.js";
import { findUserReceipt, persistUserReceipt, requestHash } from "../commands/receipts.js";
import { appendAudit } from "./audit.js";
import { loadMembership } from "./authorization.js";

/**
 * Workspace lifecycle (contract §C4/C8): creation is idempotent per human
 * via user-scoped receipts; deletion is a fresh-login, confirm-name soft
 * disable that revokes invitations, cancels pending jobs and schedules the
 * 30-day purge. The workspace row itself is the serialization lock for all
 * workspace-scoped mutations (P1 `withWorkspaceTransaction`).
 */

export interface WorkspaceDto {
  id: string;
  name: string;
  role: TeamRole;
  membershipGeneration: string;
  serverEpoch: string;
  entityVersion: number;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  server_epoch: string;
  entity_version: number;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CreateWorkspaceInput {
  commandId: string;
  name: string;
}

function requireHuman(principal: Principal): { userId: string } {
  if (principal.kind !== "human") throw teamError("WORKSPACE_FORBIDDEN", "Workspaces belong to humans");
  return { userId: principal.userId };
}

function dto(row: WorkspaceRow, role: TeamRole, generation: string): WorkspaceDto {
  return {
    id: row.id,
    name: row.name,
    role,
    membershipGeneration: generation,
    serverEpoch: row.server_epoch,
    entityVersion: row.entity_version,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** POST /workspaces — creator becomes sole owner; idempotent per human. */
export async function createWorkspace(
  pool: Pool,
  principal: Principal,
  input: CreateWorkspaceInput,
): Promise<{ workspace: WorkspaceDto; created: boolean }> {
  const { userId } = requireHuman(principal);
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) {
    throw teamError("VALIDATION_FAILED", "Workspace name must be 1-200 characters after trimming");
  }
  const hash = requestHash({ kind: "workspace.create", userId, name, commandId: input.commandId });

  return withTransaction(pool, async (tx) => {
    const replay = await findUserReceipt(tx, { userId, commandId: input.commandId });
    if (replay) {
      const workspaceId = replay.resultJson.id;
      const row = (await tx.query<WorkspaceRow & { role: TeamRole; generation: string }>(
        `SELECT w.id, w.name, w.server_epoch, w.entity_version, w.updated_at, w.deleted_at, m.role, m.generation
           FROM team_workspaces w JOIN team_memberships m ON m.workspace_id = w.id AND m.user_id = $2
          WHERE w.id = $1`,
        [workspaceId, userId],
      )).rows[0];
      if (!row) throw teamError("NOT_FOUND", "Workspace not found");
      return { workspace: dto(row, row.role, row.generation), created: false };
    }

    const workspaceId = randomUUID();
    const generation = randomUUID();
    await tx.query(
      "INSERT INTO team_workspaces (id, name, server_epoch) VALUES ($1, $2, $3)",
      [workspaceId, name, randomUUID()],
    );
    await tx.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'owner', $3)`,
      [workspaceId, userId, generation],
    );
    await appendAudit(tx, {
      workspaceId,
      actor: principal,
      action: "workspace.create",
      resourceType: "workspace",
      resourceId: workspaceId,
    });
    await persistUserReceipt(tx, { userId, commandId: input.commandId, requestHash: hash }, { kind: "workspace", id: workspaceId });
    const row = (await tx.query<WorkspaceRow>("SELECT id, name, server_epoch, entity_version, updated_at, deleted_at FROM team_workspaces WHERE id = $1", [workspaceId])).rows[0]!;
    return { workspace: dto(row, "owner", generation), created: true };
  });
}

/** GET /workspaces/:w — fresh role and generation resolution on every read. */
export async function getWorkspace(pool: Pool, principal: Principal, workspaceId: string): Promise<WorkspaceDto> {
  requireHuman(principal);
  return withTransaction(pool, async (tx) => {
    const row = (await tx.query<WorkspaceRow>(
      "SELECT id, name, server_epoch, entity_version, updated_at, deleted_at FROM team_workspaces WHERE id = $1",
      [workspaceId],
    )).rows[0];
    if (!row || row.deleted_at) throw teamError("NOT_FOUND", "Workspace not found");
    const membership = await loadMembership(tx, workspaceId, principal);
    return dto(row, membership.role, membership.generation);
  });
}

/** GET /workspaces for agents — the single workspace their token belongs to. */
export async function listAgentWorkspaces(pool: Pool, tokenId: string): Promise<WorkspaceDto[]> {
  const result = await pool.query<
    WorkspaceRow & { role: TeamRole; generation: string }
  >(
    `SELECT w.id, w.name, w.server_epoch, w.entity_version, w.updated_at, w.deleted_at, m.role, m.generation
       FROM team_agent_tokens t
       JOIN team_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.owner_user_id AND m.removed_at IS NULL
       JOIN team_workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
      WHERE t.id = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND t.membership_generation = m.generation`,
    [tokenId],
  );
  return result.rows.map((row) => dto(row, row.role, row.generation));
}

/** GET /workspaces — the caller's active memberships, newest update first. */
export async function listWorkspaces(pool: Pool, principal: Principal): Promise<WorkspaceDto[]> {
  const { userId } = requireHuman(principal);
  const result = await pool.query<
    WorkspaceRow & { role: TeamRole; generation: string }
  >(
    `SELECT w.id, w.name, w.server_epoch, w.entity_version, w.updated_at, w.deleted_at, m.role, m.generation
       FROM team_memberships m
       JOIN team_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.removed_at IS NULL AND w.deleted_at IS NULL
      ORDER BY w.updated_at DESC, w.id`,
    [userId],
  );
  return result.rows.map((row) => dto(row, row.role, row.generation));
}

/** workspace.rename command handler — runs inside the workspace tx. */
export async function renameWorkspace(
  tx: PoolClient,
  workspaceId: string,
  actor: Principal,
  input: { name: string; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  const current = (await tx.query<{ entity_version: number }>(
    "SELECT entity_version FROM team_workspaces WHERE id = $1 FOR UPDATE",
    [workspaceId],
  )).rows[0];
  if (!current) throw teamError("NOT_FOUND", "Workspace not found");
  if (current.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Workspace was modified; refresh and retry");
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) {
    throw teamError("VALIDATION_FAILED", "Workspace name must be 1-200 characters after trimming");
  }
  const updated = (await tx.query<{ entity_version: number }>(
    `UPDATE team_workspaces SET name = $2, entity_version = entity_version + 1, updated_at = now()
      WHERE id = $1 RETURNING entity_version`,
    [workspaceId, name],
  )).rows[0]!;
  await appendAudit(tx, {
    workspaceId,
    actor,
    action: "workspace.rename",
    resourceType: "workspace",
    resourceId: workspaceId,
  });
  return { entityVersion: updated.entity_version };
}

/**
 * workspace.delete command handler — soft disable now, purge after 30 days.
 * Requires a fresh sign-in and a confirming name; revokes invitations and
 * cancels pending jobs transactionally.
 */
export async function deleteWorkspace(
  tx: PoolClient,
  workspaceId: string,
  actor: Principal,
  input: { confirmName: string; expectedEntityVersion: number; authenticatedAt: Date },
): Promise<{ entityVersion: number }> {
  const current = (await tx.query<{ name: string; entity_version: number }>(
    "SELECT name, entity_version FROM team_workspaces WHERE id = $1 FOR UPDATE",
    [workspaceId],
  )).rows[0];
  if (!current) throw teamError("NOT_FOUND", "Workspace not found");
  if (current.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Workspace was modified; refresh and retry");
  }
  if (input.confirmName.trim() !== current.name.trim()) {
    throw teamError("VALIDATION_FAILED", "confirmName does not match the workspace name");
  }
  const tenMinutes = 10 * 60_000;
  if (Date.now() - input.authenticatedAt.getTime() > tenMinutes) {
    throw teamError("UNAUTHENTICATED", "Workspace deletion requires a fresh login");
  }
  const updated = (await tx.query<{ entity_version: number }>(
    `UPDATE team_workspaces
        SET deleted_at = now(), entity_version = entity_version + 1, updated_at = now(),
            purge_after = now() + interval '30 days'
      WHERE id = $1 RETURNING entity_version`,
    [workspaceId],
  )).rows[0]!;
  await tx.query(
    "UPDATE team_invitations SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL",
    [workspaceId],
  );
  await tx.query(
    "UPDATE team_jobs SET status = 'cancelled', updated_at = now() WHERE workspace_id = $1 AND status = 'pending'",
    [workspaceId],
  );
  await appendAudit(tx, {
    workspaceId,
    actor,
    action: "workspace.delete",
    resourceType: "workspace",
    resourceId: workspaceId,
  });
  return { entityVersion: updated.entity_version };
}
