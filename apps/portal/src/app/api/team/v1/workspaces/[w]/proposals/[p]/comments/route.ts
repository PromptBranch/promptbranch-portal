import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listComments } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/proposals/:p/comments — contributor+. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; p: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w, p } = await context.params;
    await requireMemberRole(service, auth, w, "contributor");
    return teamJson(requestId, { items: await listComments(service.pool, w, p), nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
