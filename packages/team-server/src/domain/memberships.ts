import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import type { TeamRole } from "../commands/operations.js";
import { appendAudit } from "./audit.js";

/**
 * Membership management (contract §C1/C6/C8). Role changes, removals and
 * re-adds all rotate `membershipGeneration` and bump the row's entity
 * version; downgrades and removals revoke the member's delegated agent
 * tokens. The last active owner can never be demoted or removed — ownership
 * must be transferred first. Because every mutation runs inside the locked
 * workspace transaction, concurrent owner changes serialize and the
 * workspace always keeps an owner.
 */

const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  owner: 4,
};

export interface MemberSummary {
  userId: string;
  displayName: string;
  email: string;
  role: TeamRole;
  entityVersion: number;
}

interface MembershipRow {
  user_id: string;
  role: TeamRole;
  entity_version: number;
  removed_at: Date | null;
}

/** GET /workspaces/:w/members — owner only (enforced by the caller). */
export async function listMembers(pool: Pool, workspaceId: string): Promise<MemberSummary[]> {
  const result = await pool.query<{
    user_id: string;
    display_name: string;
    verified_email: string;
    role: TeamRole;
    entity_version: number;
  }>(
    `SELECT m.user_id, u.display_name, u.verified_email, m.role, m.entity_version
       FROM team_memberships m
       JOIN team_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.removed_at IS NULL
      ORDER BY u.display_name, m.user_id`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.verified_email,
    role: row.role,
    entityVersion: row.entity_version,
  }));
}

async function countOtherActiveOwners(tx: PoolClient, workspaceId: string, userId: string): Promise<number> {
  const result = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM team_memberships
      WHERE workspace_id = $1 AND user_id <> $2 AND role = 'owner' AND removed_at IS NULL`,
    [workspaceId, userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function loadTarget(tx: PoolClient, workspaceId: string, userId: string): Promise<MembershipRow> {
  const result = await tx.query<MembershipRow>(
    "SELECT user_id, role, entity_version, removed_at FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row || row.removed_at) throw teamError("NOT_FOUND", "Member not found");
  return row;
}

/** member.role command handler. Returns the new entity version. */
export async function changeMemberRole(
  tx: PoolClient,
  workspaceId: string,
  actor: Principal,
  input: { userId: string; role: TeamRole; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  const target = await loadTarget(tx, workspaceId, input.userId);
  if (target.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Member record changed; refresh and retry");
  }
  if (target.role === "owner" && input.role !== "owner" && (await countOtherActiveOwners(tx, workspaceId, input.userId)) === 0) {
    throw teamError("LAST_OWNER", "Promote another member to owner before demoting yourself");
  }
  const updated = (await tx.query<{ entity_version: number }>(
    `UPDATE team_memberships
        SET role = $3, generation = $4, entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND user_id = $2 RETURNING entity_version`,
    [workspaceId, input.userId, input.role, randomUUID()],
  )).rows[0]!;
  // Downgrades revoke delegated capabilities (contract §C5); lateral moves
  // and promotions keep them.
  if (ROLE_RANK[input.role] < ROLE_RANK[target.role]) {
    await tx.query(
      `UPDATE team_agent_tokens SET revoked_at = now()
        WHERE workspace_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
      [workspaceId, input.userId],
    );
  }
  await appendAudit(tx, {
    workspaceId,
    actor,
    action: "member.role",
    resourceType: "member",
    resourceId: input.userId,
    metadata: { role: input.role },
  });
  return { entityVersion: updated.entity_version };
}

/** member.remove command handler — removal always revokes agent tokens. */
export async function removeMember(
  tx: PoolClient,
  workspaceId: string,
  actor: Principal,
  input: { userId: string; expectedEntityVersion: number },
): Promise<{ entityVersion: number }> {
  const target = await loadTarget(tx, workspaceId, input.userId);
  if (target.entity_version !== input.expectedEntityVersion) {
    throw teamError("STALE_ENTITY", "Member record changed; refresh and retry");
  }
  if (target.role === "owner" && (await countOtherActiveOwners(tx, workspaceId, input.userId)) === 0) {
    throw teamError("LAST_OWNER", "Transfer ownership before removing the last owner");
  }
  const updated = (await tx.query<{ entity_version: number }>(
    `UPDATE team_memberships
        SET removed_at = now(), generation = $3, entity_version = entity_version + 1, updated_at = now()
      WHERE workspace_id = $1 AND user_id = $2 RETURNING entity_version`,
    [workspaceId, input.userId, randomUUID()],
  )).rows[0]!;
  await tx.query(
    `UPDATE team_agent_tokens SET revoked_at = now()
      WHERE workspace_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
    [workspaceId, input.userId],
  );
  await appendAudit(tx, {
    workspaceId,
    actor,
    action: "member.remove",
    resourceType: "member",
    resourceId: input.userId,
  });
  return { entityVersion: updated.entity_version };
}
