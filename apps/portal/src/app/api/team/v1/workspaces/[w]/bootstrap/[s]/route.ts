import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { readBootstrapPage, teamError, withWorkspaceTransaction } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/workspaces/:w/bootstrap/:s — signed page tokens; access,
 * epoch and generation are rechecked on EVERY page (contract §C7).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; s: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w, s } = await context.params;
    const current = await withWorkspaceTransaction(service.pool, { workspaceId: w }, async ({ workspace, tx }) => {
      const membership = await tx.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [w, auth.userId],
      );
      return { epoch: workspace.server_epoch, generation: membership.rows[0]?.generation ?? null };
    });
    if (!current.generation) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");

    const search = new URL(request.url).searchParams;
    const page = await readBootstrapPage(service.pool, {
      principal: auth,
      workspaceId: w,
      snapshotId: s,
      pageToken: search.get("pageToken") ?? undefined,
      signer: service.cursorSigner,
      currentEpoch: current.epoch,
      currentGeneration: current.generation,
      limit: search.get("limit") ? Number(search.get("limit")) : undefined,
    });
    return teamJson(requestId, page);
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
