import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getPublishedRevisionDto } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/revisions/:r — publication verified. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; r: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w, r } = await context.params;
    await requireMemberRole(service, auth, w, "viewer");
    return teamJson(requestId, { revision: await getPublishedRevisionDto(service.pool, w, r) });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
