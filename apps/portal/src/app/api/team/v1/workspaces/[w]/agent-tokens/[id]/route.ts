import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { revokeAgentToken, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/team/v1/workspaces/:w/agent-tokens/:id — token owner or workspace owner. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ w: string; id: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      throw teamError("ROLE_FORBIDDEN", "Agent tokens are revoked by humans");
    }
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    const { w, id } = await context.params;
    const epochRow = await service.pool.query<{ server_epoch: string }>(
      "SELECT server_epoch FROM team_workspaces WHERE id = $1",
      [w],
    );
    await revokeAgentToken(service.pool, auth, w, id, epochRow.rows[0]?.server_epoch ?? "");
    return teamJson(requestId, { ok: true });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
