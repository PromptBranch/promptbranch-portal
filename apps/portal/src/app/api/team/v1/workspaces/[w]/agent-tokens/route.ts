import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { createAgentToken, listAgentTokens, teamError } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol, readTeamJsonBody } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";
import { requireCsrf } from "@/lib/team/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.strictObject({
  commandId: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(["catalog:read", "proposal:write", "note:write", "run:write"])).max(4),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

/** GET /api/team/v1/workspaces/:w/agent-tokens — own metadata; owner sees all. */
export async function GET(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    const { w } = await context.params;
    const items = await listAgentTokens(service.pool, auth, w);
    return teamJson(requestId, { items, nextPageToken: null });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}

/** POST — 201 with the secret on creation; 200 replay with secretAvailable:false. */
export async function POST(request: NextRequest, context: { params: Promise<{ w: string }> }) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind !== "human") {
      throw teamError("ROLE_FORBIDDEN", "Agent tokens are minted by humans");
    }
    if (auth.via === "cookie" && auth.webSession) {
      requireCsrf(service, request, auth.webSession);
    }
    const body = await readTeamJsonBody(request);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw teamError("VALIDATION_FAILED", "Expected {commandId, name, scopes, expiresInDays?}");
    const { w } = await context.params;
    const epochRow = await service.pool.query<{ server_epoch: string }>(
      "SELECT server_epoch FROM team_workspaces WHERE id = $1",
      [w],
    );
    const created = await createAgentToken(service.pool, auth, w, epochRow.rows[0]?.server_epoch ?? "", parsed.data);
    return teamJson(
      requestId,
      {
        id: created.tokenId,
        ...(created.token ? { token: created.token } : {}),
        expiresAt: created.expiresAt,
        secretAvailable: created.secretAvailable,
      },
      { status: created.secretAvailable ? 201 : 200 },
    );
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
