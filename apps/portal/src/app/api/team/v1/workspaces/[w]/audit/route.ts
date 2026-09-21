import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listAudit } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w/audit — owner only; metadata-only rows. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    await requireMemberRole(service, auth, w, "owner");
    const limitParam = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50;
    const items = await listAudit(service.pool, w, { limit });
    return teamJson(requestId, { items, nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
