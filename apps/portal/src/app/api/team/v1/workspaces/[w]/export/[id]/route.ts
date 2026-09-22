import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { readExportPage, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamBaseHeaders, teamErrorResponse, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/workspaces/:w/export/:id?page=<token> — one bounded page
 * of NDJSON records. Ownership is rechecked on EVERY page; the next page
 * token rides the x-pb-team-export-next-page header so the body stays pure
 * NDJSON.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string; id: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      throw teamError("ROLE_FORBIDDEN", "Exports are performed by the human workspace owner");
    }
    const { w, id } = await context.params;
    const page = await readExportPage(service.pool, {
      workspaceId: w,
      userId: auth.userId,
      exportId: id,
      pageToken: new URL(request.url).searchParams.get("page") ?? undefined,
      signer: service.cursorSigner,
    });
    const headers = teamBaseHeaders(requestId);
    headers["content-type"] = "application/x-ndjson";
    headers["x-pb-team-export-id"] = page.exportId;
    if (page.nextPageToken) headers["x-pb-team-export-next-page"] = page.nextPageToken;
    // The trailing newline keeps the stream concatenable across pages.
    const body = page.records.length > 0 ? `${page.records.join("\n")}\n` : "";
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
