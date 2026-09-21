import { NextResponse, type NextRequest } from "next/server";
import { getTeamService } from "@/lib/team/service";
import {
  TEAM_AUTH_CORRELATION_COOKIE,
  TEAM_SESSION_COOKIE,
} from "@/lib/team/env";
import { clientIp } from "@/lib/ip";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const callbackLimiter = createRateLimiter({ capacity: 30, windowMs: 10 * 60_000 });

function authFailure(request: NextRequest, reason: "invalid_state" | "invalid_login" | "revoked" | "unavailable"): NextResponse {
  const response = NextResponse.redirect(new URL(`/team?auth=${reason}`, request.url), 303);
  response.cookies.set(TEAM_AUTH_CORRELATION_COOKIE, "", { path: "/", maxAge: 0, secure: true });
  return response;
}

/**
 * GET /team/auth/callback — consumes the single-use correlation cookie,
 * exchanges the code (openid-client validates state, PKCE, issuer, audience
 * and nonce), then maps the verified identity and mints the opaque web
 * session cookie. Replay of the callback URL cannot work: the correlation
 * cookie is gone and provider codes are single-use.
 */
export async function GET(request: NextRequest) {
  const service = getTeamService();
  const ip = clientIp(request);
  if (!callbackLimiter.check(`team-callback:${ip}`).ok) {
    return authFailure(request, "unavailable");
  }
  if (!service) return authFailure(request, "unavailable");

  const correlationRaw = request.cookies.get(TEAM_AUTH_CORRELATION_COOKIE)?.value;
  if (!correlationRaw) return authFailure(request, "invalid_state");

  let correlation: { state: string; nonce: string; codeVerifier: string; redirectUri: string; next?: string };
  try {
    correlation = JSON.parse(service.secretBox.openFromString(correlationRaw));
  } catch {
    return authFailure(request, "invalid_state");
  }

  try {
    // The browser/proxy may present a different host spelling (e.g. an
    // in-app browser normalizing 127.0.0.1 to localhost). The token exchange
    // must send exactly the redirect_uri from the authorization request, so
    // rebuild the callback URL on the configured public origin.
    const configured = new URL(service.env.TEAM_PUBLIC_ORIGIN);
    const callbackUrl = new URL(request.url);
    callbackUrl.protocol = configured.protocol;
    callbackUrl.host = configured.host;
    const login = await service.webOidc.callback(callbackUrl.href, {
      redirectUri: correlation.redirectUri,
      state: correlation.state,
      nonce: correlation.nonce,
      codeVerifier: correlation.codeVerifier,
    });
    const { sub, sid, email, emailVerified, displayName, preferredUsername } = login.claims;
    if (!sub || !sid || !email || !emailVerified) {
      // A verified email and a provider session id are mandatory (C5).
      return authFailure(request, "invalid_login");
    }

    const user = await service.sessions.mapUser({
      issuer: service.env.TEAM_OIDC_ISSUER,
      subject: sub,
      email,
      displayName: displayName ?? preferredUsername ?? email.split("@")[0] ?? "Team member",
    });
    const appSession = await service.sessions.resolveAppSession(
      {
        issuer: service.env.TEAM_OIDC_ISSUER,
        subject: sub,
        providerSessionId: sid,
        clientId: service.env.TEAM_WEB_CLIENT_ID,
      },
      user.userId,
    );
    const webSession = await service.sessions.createWebSession({
      appSessionId: appSession.appSessionId,
      refreshToken: login.refreshToken,
      csrfToken: undefined,
    });

    // Landing target was sealed into the correlation blob at login start;
    // only same-site /team paths are honored.
    const landing = correlation.next && correlation.next.startsWith("/team/") ? correlation.next : "/team";
    const response = NextResponse.redirect(new URL(landing, request.url), 303);
    response.cookies.set(TEAM_SESSION_COOKIE, webSession.token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor((webSession.expiresAt.getTime() - Date.now()) / 1000),
    });
    // Readable companion cookie carrying the CSRF token: same-origin scripts
    // echo it in the x-pb-team-csrf header; the server compares its hash
    // against the session row. Never HttpOnly, never sent cross-site (Lax).
    response.cookies.set("pb-team-csrf", webSession.csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor((webSession.expiresAt.getTime() - Date.now()) / 1000),
    });
    response.cookies.set(TEAM_AUTH_CORRELATION_COOKIE, "", { path: "/", maxAge: 0, secure: true });
    return response;
  } catch (error) {
    // A revoked (issuer, sid, client, user) key must not silently re-login.
    const code = (error as { code?: string }).code;
    if (code === "SESSION_REVOKED") {
      return authFailure(request, "revoked");
    }
    // Redacted reason for operators: error codes only, never tokens/claims.
    console.warn(`[team-auth] login callback rejected: ${code ?? "UNKNOWN"}`);
    return authFailure(request, "invalid_login");
  }
}
