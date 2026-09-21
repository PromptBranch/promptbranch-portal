import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listMembers } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/members — owner only. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    await requireMemberRole(service, auth, w, "owner");
    return teamJson(requestId, { items: await listMembers(service.pool, w), nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
