import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest, listUserWorkspaces, loadUserRow } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fresh-login window for destructive self-service actions (contract C8). */
const FRESH_LOGIN_WINDOW_MS = 10 * 60_000;

/** GET /api/team/v1/me — verified-email human identity plus workspaces. */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      throw teamError("UNAUTHENTICATED", "/me is available to verified human accounts only");
    }
    const [user, workspaces] = await Promise.all([
      loadUserRow(service, auth.userId),
      listUserWorkspaces(service, auth.userId),
    ]);
    return teamJson(requestId, { user, workspaces });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}

const deleteMeSchema = z.object({ confirmEmail: z.string().min(3).max(320) });

/** DELETE /api/team/v1/me — fresh-login account deletion with last-owner protection. */
export async function DELETE(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      throw teamError("UNAUTHENTICATED", "/me is available to verified human accounts only");
    }
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    const body = await readTeamJsonBody(request);
    const parsed = deleteMeSchema.safeParse(body);
    if (!parsed.success) {
      throw teamError("VALIDATION_FAILED", "confirmEmail is required");
    }
    await service.sessions.deleteAccount({
      userId: auth.userId,
      appSessionId: auth.sessionId,
      confirmEmail: parsed.data.confirmEmail,
      freshWindowMs: FRESH_LOGIN_WINDOW_MS,
    });
    return teamJson(requestId, { ok: true });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
