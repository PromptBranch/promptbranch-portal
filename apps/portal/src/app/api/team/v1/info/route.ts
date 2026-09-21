import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { teamErrorResponse, teamJson } from "@/lib/team/http";
import {
  TEAM_CONTRACT_VERSION,
  TEAM_FEATURES,
  TEAM_LIMITS,
  TEAM_PROTOCOL_VERSION,
} from "@/lib/team/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/info — public discovery (contract C4). Exempt from the
 * protocol-header requirement; advertises no secrets.
 */
export async function GET(_request: NextRequest) {
  const requestId = randomUUID();
  try {
    const service = getTeamService();
    if (!service) return teamErrorResponse(requestId, new Error("disabled"));
    return teamJson(requestId, {
      protocol: TEAM_PROTOCOL_VERSION,
      contractVersion: TEAM_CONTRACT_VERSION,
      serverId: service.env.TEAM_SERVER_ID,
      serverEpoch: service.env.TEAM_SERVER_EPOCH,
      features: [...TEAM_FEATURES],
      issuer: service.env.TEAM_OIDC_ISSUER,
      nativeClientId: service.env.TEAM_NATIVE_CLIENT_ID,
      cliClientId: service.env.TEAM_CLI_CLIENT_ID,
      audience: service.env.TEAM_OIDC_AUDIENCE,
      limits: TEAM_LIMITS,
    });
  } catch (error) {
    return teamErrorResponse(requestId, error);
  }
}
