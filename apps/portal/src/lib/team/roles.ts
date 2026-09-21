import { teamError, withWorkspaceTransaction, type TeamRole } from "@promptbranch/team-server";
import type { TeamService } from "./service";
import type { HumanAuthContext } from "./auth";

/**
 * Read-side authorization for workspace-scoped GETs: resolves the caller's
 * CURRENT membership (fresh role + generation) inside a short transaction.
 * Server components and route adapters both use this — middleware or UI
 * hiding is never authorization.
 */

const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  owner: 4,
};

export async function requireMemberRole(
  service: TeamService,
  auth: HumanAuthContext,
  workspaceId: string,
  minimumRole: TeamRole,
): Promise<{ role: TeamRole; generation: string; entityVersion: number }> {
  return withWorkspaceTransaction(service.pool, { workspaceId }, async ({ tx }) => {
    const result = await tx.query<{
      role: TeamRole;
      generation: string;
      entity_version: number;
    }>(
      `SELECT role, generation, entity_version FROM team_memberships
        WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [workspaceId, auth.userId],
    );
    const row = result.rows[0];
    if (!row) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
    if (ROLE_RANK[row.role] < ROLE_RANK[minimumRole]) {
      throw teamError("ROLE_FORBIDDEN", `This action requires the ${minimumRole} role`);
    }
    return { role: row.role, generation: row.generation, entityVersion: row.entity_version };
  });
}
