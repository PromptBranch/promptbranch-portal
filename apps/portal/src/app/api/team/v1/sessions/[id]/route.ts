import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/team/v1/sessions/:id — revoke one of the caller's own sessions. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    const { id } = await context.params;
    await service.sessions.revokeUserSession(auth.userId, id);
    return teamJson(requestId, { ok: true });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
