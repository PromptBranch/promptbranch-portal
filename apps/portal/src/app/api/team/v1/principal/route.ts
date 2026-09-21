import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { principalId } from "@promptbranch/team-server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson, requireProtocol } from "@/lib/team/http";
import { authenticateRequest } from "@/lib/team/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/principal — server-authored cache/ownership identity for
 * humans and (from P6) scoped agents. No secrets; the client never supplies
 * these values.
 */
export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    requireProtocol(request);
    const service = getTeamService();
    if (!service) throw new Error("disabled");
    const auth = await authenticateRequest(service, request);
    if (auth.kind === "agent") {
      return teamJson(requestId, {
        kind: "agent",
        principalId: `agent:${auth.tokenId}`,
        userId: auth.userId,
        agentTokenId: auth.tokenId,
        scopes: auth.scopes,
      });
    }
    return teamJson(requestId, {
      kind: "human",
      principalId: principalId({ kind: "human", userId: auth.userId, sessionId: auth.sessionId, authenticatedAt: auth.authenticatedAt }),
      userId: auth.userId,
      agentTokenId: null,
      scopes: [],
    });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
