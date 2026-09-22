import { consumeRateBucket, teamError, withWorkspaceTransaction, READS_PER_MINUTE, type TeamRole } from "@promptbranch/team-server";
import type { TeamService } from "./service";
import type { HumanAuthContext } from "./auth";

/**
 * Read-side authorization for workspace-scoped GETs: resolves the caller's
 * CURRENT membership (fresh role + generation) inside a short transaction.
 * Server components and route adapters both use this — middleware or UI
 * hiding is never authorization. Also consumes the shared C8 read quota
 * (300/minute/principal/workspace) so every surface funneling through here
 * — JSON routes and SSR pages alike — shares one Postgres bucket.
 */

const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 1,
  contributor: 2,
  maintainer: 3,
  owner: 4,
};

export async function requireMemberRole(
  service: TeamService,
  auth: HumanAuthContext | { kind: "agent"; userId: string; tokenId: string; scopes: string[] },
  workspaceId: string,
  minimumRole: TeamRole,
  options: { agentOwnScoped?: boolean } = {},
): Promise<{ role: TeamRole; generation: string; entityVersion: number }> {
  // Read quota first (C8): 300/minute per principal per workspace, shared
  // across API reads and SSR page loads, enforced in Postgres like writes.
  await consumeRateBucket(
    service.pool,
    `read:${workspaceId}:${auth.kind === "agent" ? `agent:${auth.tokenId}` : `user:${auth.userId}`}`,
    READS_PER_MINUTE,
    60_000,
  );
  if (auth.kind === "agent") {
    // Agent reads require catalog:read plus a current membership; the
    // workspace-scoped token cannot read another workspace at all. Agents
    // never inherit the owner's authority: elevated read floors (members,
    // invitations, audit, export) are human-only regardless of role. The
    // one contract exception is the proposal surface: agents see proposals
    // at the contributor floor scoped to their OWN submissions (C4) — the
    // caller must apply that scoping to every query it then runs.
    if (minimumRole !== "viewer" && !(options.agentOwnScoped && minimumRole === "contributor")) {
      throw teamError("ROLE_FORBIDDEN", "This surface is restricted to human members");
    }
    if (!auth.scopes.includes("catalog:read")) {
      throw teamError("SCOPE_FORBIDDEN", "Agent token lacks the catalog:read scope");
    }
    return withWorkspaceTransaction(service.pool, { workspaceId }, async ({ tx }) => {
      const row = await tx.query<{ role: TeamRole; generation: string; entity_version: number }>(
        `SELECT m.role, m.generation, m.entity_version
           FROM team_agent_tokens t
           JOIN team_memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.owner_user_id
          WHERE t.workspace_id = $1 AND t.id = $2 AND t.revoked_at IS NULL AND t.expires_at > now()
            AND m.removed_at IS NULL AND t.membership_generation = m.generation`,
        [workspaceId, auth.tokenId],
      );
      const membership = row.rows[0];
      if (!membership) throw teamError("UNAUTHENTICATED", "Agent token is no longer valid");
      if (ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
        throw teamError("ROLE_FORBIDDEN", `This action requires the ${minimumRole} role`);
      }
      return { role: membership.role, generation: membership.generation, entityVersion: membership.entity_version };
    });
  }
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
