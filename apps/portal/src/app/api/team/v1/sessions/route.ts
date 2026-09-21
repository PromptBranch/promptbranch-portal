import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/sessions — the caller's own sign-in sessions. */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const items = await service.sessions.listUserSessions(auth.userId);
    return teamJson(requestId, { items, nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
