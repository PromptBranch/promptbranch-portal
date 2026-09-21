import type { NextRequest } from "next/server";
import { teamError } from "@promptbranch/team-server";
import type { ResolvedWebSession } from "@promptbranch/team-server";
import { TEAM_CSRF_HEADER } from "./env";
import type { TeamService } from "./service";

/**
 * CSRF protection for cookie-authenticated mutations (contract C5): the
 * request must present the session's stored CSRF token AND, when an Origin
 * header is present, it must be same-origin with the configured public
 * origin. Bearer-authenticated calls (no ambient cookie authority) skip
 * this — the token itself is the proof of intent.
 */

export function requireCsrf(
  service: TeamService,
  request: NextRequest,
  webSession: ResolvedWebSession,
): void {
  const presented = request.headers.get(TEAM_CSRF_HEADER);
  if (!presented || !service.sessions.csrfMatches(webSession, presented)) {
    throw teamError("UNAUTHENTICATED", "Missing or invalid CSRF token");
  }
  const origin = request.headers.get("origin");
  if (origin) {
    const configured = new URL(service.env.TEAM_PUBLIC_ORIGIN).origin;
    let presentedOrigin: string;
    try {
      presentedOrigin = new URL(origin).origin;
    } catch {
      throw teamError("UNAUTHENTICATED", "Invalid Origin header");
    }
    if (presentedOrigin !== configured) {
      throw teamError("UNAUTHENTICATED", "Cross-origin mutations are not allowed");
    }
  }
}
