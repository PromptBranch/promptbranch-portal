import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listActivityItems, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/workspaces/:w/activity-items — contributor+ humans;
 * agents see only the items they created. Requires the promptId filter.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    await requireMemberRole(service, auth, w, "contributor");
    const search = new URL(request.url).searchParams;
    const promptId = search.get("promptId");
    if (!promptId) {
      throw teamError("VALIDATION_FAILED", "promptId is required");
    }
    const result = await listActivityItems(service.pool, {
      workspaceId: w,
      viewer: auth,
      promptId,
      limit: search.get("limit") ? Number(search.get("limit")) : undefined,
      pageToken: search.get("pageToken") ?? undefined,
    });
    return teamJson(requestId, result);
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
