import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { startBootstrap, teamError, withWorkspaceTransaction } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, MAX_TEAM_REQUEST_BYTES } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bootstrapSchema = z.strictObject({
  membershipGeneration: z.string().uuid(),
  serverEpoch: z.string().uuid(),
});

/**
 * POST /api/team/v1/workspaces/:w/bootstrap — 201 on materialization, 200 on
 * reuse of a still-valid snapshot for the same principal/generation/epoch.
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
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_TEAM_REQUEST_BYTES) throw teamError("PAYLOAD_TOO_LARGE", "Request body exceeds the 256 KiB limit");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const parsed = bootstrapSchema.safeParse(body);
    if (!parsed.success) throw teamError("VALIDATION_FAILED", "Expected {membershipGeneration, serverEpoch}");
    const { w } = await context.params;

    // Current epoch/generation resolve inside the same locked transaction
    // the snapshot materializes under.
    const current = await withWorkspaceTransaction(service.pool, { workspaceId: w }, async ({ workspace, tx }) => {
      const membership = await tx.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [w, auth.userId],
      );
      return { epoch: workspace.server_epoch, generation: membership.rows[0]?.generation ?? null };
    });
    if (!current.generation) throw teamError("WORKSPACE_FORBIDDEN", "Not a member of this workspace");

    const result = await startBootstrap(service.pool, {
      principal: auth,
      workspaceId: w,
      membershipGeneration: parsed.data.membershipGeneration,
      serverEpoch: parsed.data.serverEpoch,
      currentEpoch: current.epoch,
      currentGeneration: current.generation,
    });
    return teamJson(
      requestId,
      {
        snapshotId: result.snapshotId,
        highWater: result.highWater,
        expiresAt: result.expiresAt,
        serverEpoch: result.serverEpoch,
        membershipGeneration: result.membershipGeneration,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
