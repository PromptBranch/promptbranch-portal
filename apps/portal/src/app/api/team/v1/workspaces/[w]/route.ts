import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getWorkspace } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces/:w — member read with fresh role/generation. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    return teamJson(requestId, { workspace: await getWorkspace(service.pool, auth, w) });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
