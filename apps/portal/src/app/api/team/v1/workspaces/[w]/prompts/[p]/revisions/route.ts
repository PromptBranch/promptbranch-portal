import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listPublishedRevisions } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/prompts/:p/revisions — published history. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; p: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w, p } = await context.params;
    await requireMemberRole(service, auth, w, "viewer");
    const search = new URL(request.url).searchParams;
    const result = await listPublishedRevisions(service.pool, w, p, {
      limit: search.get("limit") ? Number(search.get("limit")) : undefined,
      pageToken: search.get("pageToken") ?? undefined,
    });
    return teamJson(requestId, result);
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
