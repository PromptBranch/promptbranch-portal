import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { TEAM_SESSION_COOKIE } from "@/lib/team/env";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/team/v1/sessions/revoke-all — invalidate every human session of
 * the caller (personal agent tokens join in P6). Cookie-authenticated calls
 * also lose their own browser cookie immediately.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    await service.sessions.revokeAllUserSessions(auth.userId);
    const response = teamJson(requestId, { ok: true });
    if (auth.via === "cookie") {
      response.cookies.set(TEAM_SESSION_COOKIE, "", { path: "/", maxAge: 0, secure: true });
      response.cookies.set("pb-team-csrf", "", { path: "/", maxAge: 0, secure: true });
    }
    return response;
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
