import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { feedBounds, readChanges, teamError, withWorkspaceTransaction } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/workspaces/:w/changes — commit-ordered feed after a
 * cursor, with epoch/generation rebinding and retention-enforced cursors.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    const search = new URL(request.url).searchParams;
    const after = search.get("after");
    const epoch = search.get("serverEpoch");
    const generation = search.get("membershipGeneration");
    if (!after || !epoch || !generation) {
      throw teamError("VALIDATION_FAILED", "after, serverEpoch and membershipGeneration are required");
    }

    const current = await withWorkspaceTransaction(service.pool, { workspaceId: w }, async ({ workspace, tx }) => {
      const membership = await tx.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [w, auth.userId],
      );
      return { epoch: workspace.server_epoch, generation: membership.rows[0]?.generation ?? null };
    });
    if (!current.generation) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");
    if (epoch !== current.epoch) throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; bootstrap again");
    if (generation !== current.generation) throw teamError("MEMBERSHIP_CHANGED", "Membership changed; refresh your generation");

    const bounds = await feedBounds(service.pool, w);
    const page = await readChanges(service.pool, {
      workspaceId: w,
      after,
      limit: search.get("limit") ? Number(search.get("limit")) : undefined,
      minRetainedSeq: bounds.minRetainedSeq,
      currentMaxSeq: bounds.currentMaxSeq,
    });
    return teamJson(requestId, {
      changes: page.changes,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      serverEpoch: current.epoch,
      membershipGeneration: current.generation,
    });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
