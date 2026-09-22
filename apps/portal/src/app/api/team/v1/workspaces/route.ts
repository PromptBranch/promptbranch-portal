import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import {
  consumeRateBucket,
  teamError,
  createWorkspace,
  listAgentWorkspaces,
  listWorkspaces,
  WRITES_PER_MINUTE,
} from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/team/v1/workspaces — the caller's active memberships. */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind === "agent") {
      // Agents are workspace-scoped capabilities: exactly one workspace.
      return teamJson(requestId, { items: await listAgentWorkspaces(service.pool, auth.tokenId), nextPageToken: null });
    }
    return teamJson(requestId, { items: await listWorkspaces(service.pool, auth), nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}

const createSchema = z.strictObject({
  commandId: z.string().uuid(),
  name: z.string().min(1).max(100),
});

/** POST /api/team/v1/workspaces — 201 on creation, 200 on idempotent replay. */
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
    // Shares the C8 write quota with command dispatch (same bucket key).
    await consumeRateBucket(
      service.pool,
      `cmdwrite:user:${auth.userId}`,
      WRITES_PER_MINUTE,
      60_000,
    );
    const body = await readTeamJsonBody(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw teamError("VALIDATION_FAILED", "Expected {commandId, name}");
    const result = await createWorkspace(service.pool, auth, parsed.data);
    return teamJson(requestId, { workspace: result.workspace }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
