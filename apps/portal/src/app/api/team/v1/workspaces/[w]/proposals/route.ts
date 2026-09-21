import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { listProposals, type ProposalStatus } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireMemberRole } from "@/lib/team/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["open", "approved", "rejected", "withdrawn", "superseded"]);

/** GET /api/team/v1/workspaces/:w/proposals — contributor+ surface. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    await requireMemberRole(service, auth, w, "contributor");
    const search = new URL(request.url).searchParams;
    const status = search.get("status");
    const result = await listProposals(service.pool, w, {
      promptId: search.get("promptId") ?? undefined,
      status: status && STATUSES.has(status) ? (status as ProposalStatus) : undefined,
      limit: search.get("limit") ? Number(search.get("limit")) : undefined,
      pageToken: search.get("pageToken") ?? undefined,
    });
    return teamJson(requestId, result);
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
