import { randomUUID } from "node:crypto";
import type { PoolClient } from "../db.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { principalId } from "../auth/principal.js";
import type { Pool } from "../db.js";
import type { TeamRole } from "../commands/operations.js";

/**
 * Server-side authorization (contract §C1/C6). Every membership check reads
 * the CURRENT row inside the caller's workspace transaction — never a cached
 * role, never a client-supplied one. Whichever transaction holds the
 * workspace lock first defines before/after authorization.
 */

const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  owner: 4,
};

export interface MembershipContext {
  userId: string;
  role: TeamRole;
  generation: string;
  entityVersion: number;
}

/** Loads the principal's active membership inside the locked workspace tx. */
export async function loadMembership(
  tx: PoolClient,
  workspaceId: string,
  principal: Principal,
): Promise<MembershipContext> {
  if (principal.kind !== "human") {
    // Agent capabilities never carry membership authority (contract §C1);
    // P6 mints read/write scopes, ownership stays human.
    throw teamError("WORKSPACE_FORBIDDEN", "Membership operations require a human member");
  }
  const result = await tx.query<{ user_id: string; role: TeamRole; generation: string; entity_version: number }>(
    `SELECT user_id, role, generation, entity_version
       FROM team_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL
      FOR SHARE`,
    [workspaceId, principal.userId],
  );
  const row = result.rows[0];
  if (!row) {
    // Generic 403 without workspace metadata (contract §C2).
    throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
  }
  return {
    userId: row.user_id,
    role: row.role,
    generation: row.generation,
    entityVersion: row.entity_version,
  };
}

/** Throws unless the membership satisfies both the role floor and the generation. */
export function authorizeOperation(
  membership: MembershipContext,
  options: { requiredRole: TeamRole; generation: string },
): void {
  if (ROLE_RANK[membership.role] < ROLE_RANK[options.requiredRole]) {
    throw teamError("ROLE_FORBIDDEN", `This action requires the ${options.requiredRole} role`);
  }
  if (membership.generation !== options.generation) {
    throw teamError("MEMBERSHIP_CHANGED", "Membership changed; refresh and retry with the current generation");
  }
}

/** Same check for reads that only need membership (any role). */
export async function requireMember(tx: PoolClient, workspaceId: string, principal: Principal): Promise<MembershipContext> {
  return loadMembership(tx, workspaceId, principal);
}

export function principalIdentifier(principal: Principal): string {
  return principalId(principal);
}

export function newGeneration(): string {
  return randomUUID();
}

export interface AgentMembershipContext {
  tokenId: string;
  ownerUserId: string;
  role: TeamRole;
  generation: string;
  scopes: string[];
}

/**
 * Loads the agent's authority inside the locked workspace tx: the token row
 * (FOR SHARE, still valid) plus the OWNER's current membership. Effective
 * access is always scopes ∩ this role — recomputed per request, never
 * cached, never client-supplied.
 */
export async function loadAgentMembership(
  tx: PoolClient,
  workspaceId: string,
  principal: Principal,
): Promise<AgentMembershipContext> {
  if (principal.kind !== "agent") {
    throw teamError("WORKSPACE_FORBIDDEN", "Expected an agent principal");
  }
  const result = await tx.query<{
    id: string;
    owner_user_id: string;
    scopes: string[];
    membership_generation: string;
    expires_at: Date;
    revoked_at: Date | null;
    role: TeamRole;
    generation: string;
    removed_at: Date | null;
    disabled_at: Date | null;
    deleted_at: Date | null;
  }>(
    `SELECT t.id, t.owner_user_id, t.scopes, t.membership_generation, t.expires_at, t.revoked_at,
            m.role, m.generation, m.removed_at, u.disabled_at, u.deleted_at
       FROM team_agent_tokens t
       JOIN team_users u ON u.id = t.owner_user_id
       JOIN team_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.owner_user_id
      WHERE t.workspace_id = $1 AND t.id = $2
      FOR SHARE OF t`,
    [workspaceId, principal.tokenId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.expires_at.getTime() <= Date.now() ||
    row.disabled_at ||
    row.deleted_at ||
    row.removed_at ||
    row.generation !== row.membership_generation
  ) {
    throw teamError("UNAUTHENTICATED", "Agent token is no longer valid");
  }
  return {
    tokenId: row.id,
    ownerUserId: row.owner_user_id,
    role: row.role,
    generation: row.generation,
    scopes: row.scopes,
  };
}

const AGENT_ROLE_RANK: Record<TeamRole, number> = ROLE_RANK;

export function agentRoleSatisfies(role: TeamRole, minimum: TeamRole): boolean {
  return AGENT_ROLE_RANK[role] >= AGENT_ROLE_RANK[minimum];
}
