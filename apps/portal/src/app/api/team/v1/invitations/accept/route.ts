import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { acceptInvitation, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const acceptSchema = z.strictObject({
  commandId: z.string().uuid(),
  token: z.string().min(20).max(200),
});

/**
 * POST /api/team/v1/invitations/accept — the ONLY invitation-consuming
 * path (email scanners hitting a GET page never consume anything).
 * Identity-bound and idempotent per user + commandId.
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
    const body = await readTeamJsonBody(request);
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) throw teamError("VALIDATION_FAILED", "Expected {commandId, token}");
    const result = await acceptInvitation(
      service.pool,
      { principal: auth, secretBox: service.secretBox, publicOrigin: service.env.TEAM_PUBLIC_ORIGIN },
      parsed.data,
    );
    return teamJson(requestId, { workspace: result.workspace });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
