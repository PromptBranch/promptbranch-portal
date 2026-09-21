import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { consumeRateBucket, executeTeamCommand, WRITES_PER_MINUTE } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EPOCH_HEADER = "x-promptbranch-team-epoch";

/**
 * POST /api/team/v1/workspaces/:w/commands — the audited dispatch entrypoint.
 * Authorization happens server-side before any receipt lookup; CSRF applies
 * to cookie-authenticated mutations; the epoch travels in a header (C6).
 * The response is a CommandReceipt only — the invitation token (if any)
 * goes exclusively through the email job.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    // Shared write quota (C8): 60 writes/minute per principal, shared with
    // workspace creation and enforced in Postgres so every instance counts.
    await consumeRateBucket(
      service.pool,
      `cmdwrite:${auth.kind === "agent" ? `agent:${auth.tokenId}` : `user:${auth.userId}`}`,
      WRITES_PER_MINUTE,
      60_000,
    );
    const body = await readTeamJsonBody(request);
    const { w } = await context.params;
    const receipt = await executeTeamCommand(
      { pool: service.pool, secretBox: service.secretBox, publicOrigin: service.env.TEAM_PUBLIC_ORIGIN },
      auth,
      w,
      request.headers.get(EPOCH_HEADER) ?? "",
      body,
    );
    return teamJson(requestId, {
      commandId: receipt.commandId,
      committedAt: receipt.committedAt,
      catalogSeq: receipt.catalogSeq,
      result: receipt.result,
    });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
