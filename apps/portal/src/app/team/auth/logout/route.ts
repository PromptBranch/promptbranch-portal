import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { TEAM_SESSION_COOKIE } from "@/lib/team/env";
import { teamErrorResponse, teamBaseHeaders } from "@/lib/team/http";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /team/auth/logout — CSRF-protected browser logout: revokes the app
 * session (authoritative, immediate) and asks the provider to revoke the
 * refresh token (best effort). Idempotent for already-signed-out browsers.
 */
export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const service = getTeamService();

  try {
    if (!service) throw new Error("disabled");
    const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value;
    if (!token) {
      const response = NextResponse.json({ ok: true }, { headers: teamBaseHeaders(requestId) });
      response.cookies.set(TEAM_SESSION_COOKIE, "", { path: "/", maxAge: 0, secure: true });
      response.cookies.set("pb-team-csrf", "", { path: "/", maxAge: 0, secure: true });
      return response;
    }

    const webSession = await service.sessions.resolveWebSession(token);
    requireCsrf(service, request, webSession);

    // Decrypt for best-effort provider revocation BEFORE dropping the row.
    const refreshToken = webSession.decryptRefreshToken();
    await service.sessions.revokeWebSessionByToken(token);
    if (refreshToken) {
      await service.webOidc.revoke(refreshToken);
    }

    const response = NextResponse.json({ ok: true }, { headers: teamBaseHeaders(requestId) });
    response.cookies.set(TEAM_SESSION_COOKIE, "", { path: "/", maxAge: 0, secure: true });
    response.cookies.set("pb-team-csrf", "", { path: "/", maxAge: 0, secure: true });
    return response;
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
