import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getProposalDetail, listComments, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/proposals/:p/comments — contributor+ (agents: own proposals only). */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; p: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w, p } = await context.params;
    await requireMemberRole(service, auth, w, "contributor", { agentOwnScoped: true });
    if (auth.kind === "agent") {
      const detail = await getProposalDetail(service.pool, w, p);
      if (detail.proposal.author.agentTokenId !== auth.tokenId) {
        throw teamError("NOT_FOUND", "Proposal not found");
      }
    }
    return teamJson(requestId, { items: await listComments(service.pool, w, p), nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
