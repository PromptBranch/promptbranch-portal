import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { teamEnabled } from "@/lib/team/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/team/v1/health/ready — readiness for orchestrators. Minimal
 * state only: no internal addresses, keys, database names or counters.
 * `recovery` is a deliberate 503: the operator is mid-restore and ordinary
 * traffic is intentionally refused. This route never requires auth or the
 * protocol header, and works while the team service is unregistered
 * (disabled or recovery mode).
 */
export async function GET(_request: NextRequest) {
  const requestId = randomUUID();
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  };

  if (!teamEnabled()) {
    const disabled = process.env.TEAM_ENABLED === "false";
    return Response.json({ status: disabled ? "disabled" : "recovery" }, { status: disabled ? 200 : 503, headers });
  }

  const service = getTeamService();
  if (!service) {
    return Response.json({ status: "degraded" }, { status: 503, headers });
  }
  try {
    await service.pool.query("SELECT 1");
    return Response.json({ status: "ok" }, { status: 200, headers });
  } catch {
    return Response.json({ status: "degraded" }, { status: 503, headers });
  }
}
