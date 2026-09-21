import { randomAuthorizationSecrets } from "@promptbranch/team-server";
import { NextResponse, type NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import { TEAM_AUTH_CORRELATION_COOKIE } from "@/lib/team/env";
import { clientIp } from "@/lib/ip";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Login starts are cheap but should not be hammerable per IP (contract C8
// auth-edge limits); distinct human identities are not known yet.
const loginLimiter = createRateLimiter({ capacity: 20, windowMs: 10 * 60_000 });

/**
 * GET /team/auth/login — starts the web code+PKCE flow. The single-use
 * correlation blob (state + nonce + code verifier) is sealed with the
 * session encryption key into a short-lived HttpOnly cookie; nothing
 * session-relevant is ever carried in the redirect URL.
 */
export async function GET(request: NextRequest) {
  const service = getTeamService();
  const ip = clientIp(request);
  if (!loginLimiter.check(`team-login:${ip}`).ok) {
    return NextResponse.redirect(new URL("/team?auth=rate_limited", request.url), 303);
  }
  if (!service) {
    return NextResponse.redirect(new URL("/team?auth=unavailable", request.url), 303);
  }

  const { state, nonce, codeVerifier } = randomAuthorizationSecrets();
  try {
    const redirectUri = `${service.env.TEAM_PUBLIC_ORIGIN.replace(/\/$/, "")}/team/auth/callback`;
    const authorizationUrl = await service.webOidc.authorizationUrl({
      redirectUri,
      state,
      nonce,
      codeVerifier,
    });
    const response = NextResponse.redirect(authorizationUrl, 303);
    const correlation = service.secretBox.sealToString(
      JSON.stringify({ state, nonce, codeVerifier, redirectUri }),
    );
    response.cookies.set(TEAM_AUTH_CORRELATION_COOKIE, correlation, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 300, // single-use, five-minute transaction (contract C5)
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/team?auth=unavailable", request.url), 303);
  }
}
