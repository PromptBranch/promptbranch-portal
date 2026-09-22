import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { startExport, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/team/v1/workspaces/:w/export — owner-only portability snapshot
 * (max 3/hour/workspace, shared quota across owners). The response carries
 * the manifest; NDJSON pages are read from the [id] route until
 * nextPageToken is null. Export is a portability format, NOT a live
 * restore/import API.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      // Elevated surfaces stay human-only regardless of the owner's role.
      throw teamError("ROLE_FORBIDDEN", "Exports are performed by the human workspace owner");
    }
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    await readTeamJsonBody(request);
    const { w } = await context.params;
    const started = await startExport(service.pool, { workspaceId: w, userId: auth.userId });
    return teamJson(requestId, { exportId: started.exportId, manifest: started.manifest, expiresAt: started.expiresAt }, { status: 201 });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
