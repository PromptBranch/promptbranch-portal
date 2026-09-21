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
