import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import * as oidc from "openid-client";
import { teamError } from "../errors.js";

/**
 * Access-token validation (contract C5). The issuer is ALWAYS
 * operator-configured — issuer/JWKS URLs are never taken from token claims.
 * ID tokens are never accepted as API access tokens.
 */

export interface AccessTokenValidatorOptions {
  /** Exactly the configured issuer (trusted source of discovery/JWKS). */
  issuer: string;
  /** Required API audience (default `promptbranch-team-api`). */
  audience: string;
  /** Bearer azp/client allowlist — native public clients only. */
  allowedClients: string[];
  /** Remote JWKS URL; overrides discovery for test injection. */
  jwksUrl?: string;
  /** Inline JWKS (test-only override; wins over jwksUrl). */
  jwksJson?: unknown;
  allowedAlgs?: string[];
  clockToleranceSeconds?: number;
}

export interface ValidatedAccess {
  issuer: string;
  subject: string;
  sessionId: string;
  clientId: string;
  email: string;
  /** Epoch milliseconds of the IdP authentication event (auth_time claim). */
  authenticatedAtMs: number;
}

export interface AccessTokenValidator {
  validate(accessToken: string): Promise<ValidatedAccess>;
}

const REQUIRED_ALGS = ["RS256", "ES256"];


export function createAccessTokenValidator(options: AccessTokenValidatorOptions): AccessTokenValidator {
  const algs = options.allowedAlgs ?? REQUIRED_ALGS;
  const clockTolerance = (options.clockToleranceSeconds ?? 5) + 1; // small, deliberate
  const keyStore: JWTVerifyGetKey =
    options.jwksJson !== undefined
      ? createLocalJWKSet(options.jwksJson as JSONWebKeySet)
      : createRemoteJWKSet(
          new URL(
            options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`,
          ),
          // Cooldown bounds re-fetch frequency after key rotation.
          { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
        );

  return {
    async validate(accessToken) {
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(accessToken, keyStore, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: algs,
          clockTolerance,
        });
        payload = verified.payload as Record<string, unknown>;
        // ID tokens carry typ "ID" in Keycloak's header; an ID token is never
        // an API access token even if an audience mapper leaked into it.
        if ((verified.protectedHeader.typ ?? "").toUpperCase() === "ID") {
          throw teamError("UNAUTHENTICATED", "ID tokens are not accepted as API access tokens");
        }
      } catch (error) {
        // Every jose failure class (ERR_JWS_* signature/structure, ERR_JWT_*
        // claims) maps to a single generic unauthenticated — never leak which
        // check failed or the token's contents.
        const code = (error as { code?: string }).code ?? "";
        if (code.startsWith("ERR_JWS") || code.startsWith("ERR_JWT")) {
          throw teamError("UNAUTHENTICATED", "Access token rejected", { cause: error });
        }
        throw error;
      }

      const subject = typeof payload.sub === "string" ? payload.sub : "";
      // Keycloak emits `sid` (newer) and `session_state` (legacy) — accept either.
      const sid =
        typeof payload.sid === "string" && payload.sid.length > 0
          ? payload.sid
          : typeof payload.session_state === "string" && payload.session_state.length > 0
            ? payload.session_state
            : "";
      const azp = typeof payload.azp === "string" && payload.azp.length > 0 ? payload.azp : "";
      const email = typeof payload.email === "string" ? payload.email : "";
      const emailVerified = payload.email_verified === true;
      const authTime =
        typeof payload.auth_time === "number"
          ? payload.auth_time * 1000
          : typeof payload.iat === "number"
            ? payload.iat * 1000
            : NaN;

      if (!subject || !sid || !email || !emailVerified) {
        throw teamError("UNAUTHENTICATED", "Access token lacks a verified identity (verified email and sid required)");
      }
      if (!options.allowedClients.includes(azp)) {
        throw teamError("UNAUTHENTICATED", "Access token was not issued to an authorized client");
      }
      if (!Number.isFinite(authTime)) {
        throw teamError("UNAUTHENTICATED", "Access token lacks an authentication time");
      }

      return {
        issuer: options.issuer,
        subject,
        sessionId: sid,
        clientId: azp,
        email,
        authenticatedAtMs: authTime,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Web (BFF) authorization-code + PKCE flow via openid-client. Discovery is
// cached per issuer+client and always fetched from the configured issuer.
// ---------------------------------------------------------------------------

export interface WebOidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export interface WebLoginParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface WebLoginResult {
  /** Validated ID-token claims from the code exchange. */
  claims: {
    sub: string;
    sid: string;
    email: string;
    emailVerified: boolean;
    preferredUsername: string | null;
    displayName: string | null;
  };
  refreshToken: string | null;
  accessTokenExpiresAtMs: number;
}

const discoveryCache = new Map<string, oidc.Configuration>();

/** Loopback HTTP development origins are the one allowed exception (contract C10). */
function isLoopbackHttpIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

async function discover(options: WebOidcClientOptions): Promise<oidc.Configuration> {
  const cacheKey = `${options.issuer}|${options.clientId}`;
  let config = discoveryCache.get(cacheKey);
  if (!config) {
    config = await oidc.discovery(new URL(options.issuer), options.clientId, options.clientSecret, undefined, {
      // openid-client is HTTPS-only by default; the reference development
      // issuer is deliberately plain HTTP on loopback (contract C10).
      // Production issuers keep the HTTPS-only restriction.
      ...(isLoopbackHttpIssuer(options.issuer) ? { execute: [oidc.allowInsecureRequests] } : {}),
    });
    discoveryCache.set(cacheKey, config);
  }
  return config;
}

export interface WebOidcClient {
  authorizationUrl(params: WebLoginParams): Promise<string>;
  /** Exchanges the code; validates state, PKCE, issuer, audience and nonce. */
  callback(callbackUrl: string, params: WebLoginParams): Promise<WebLoginResult>;
  refresh(refreshToken: string): Promise<{ refreshToken: string | null; accessTokenExpiresAtMs: number }>;
  /** Best-effort provider-side revocation; failures never break logout. */
  revoke(refreshToken: string): Promise<void>;
}

/** Fresh OAuth2 authorization-transaction secrets (state/nonce/PKCE verifier). */
export function randomAuthorizationSecrets(): { state: string; nonce: string; codeVerifier: string } {
  return { state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier() };
}

export function createWebOidcClient(options: WebOidcClientOptions): WebOidcClient {  const scope = options.scope ?? "openid profile email";
  return {
    async authorizationUrl(params) {
      const config = await discover(options);
      // The authorization request carries the S256 challenge; the verifier
      // itself is only ever sent to the token endpoint (openid-client v6 API).
      return oidc
        .buildAuthorizationUrl(config, {
          redirect_uri: params.redirectUri,
          response_type: "code",
          scope,
          state: params.state,
          nonce: params.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(params.codeVerifier),
          // Explicit method: without it the server may compare in plain mode
          // against the S256 value and every exchange fails with a code mismatch.
          code_challenge_method: "S256",
        })
        .href;
    },

    async callback(callbackUrl, params) {
      const config = await discover(options);
      const tokens = await oidc.authorizationCodeGrant(config, new URL(callbackUrl), {
        pkceCodeVerifier: params.codeVerifier,
        expectedState: params.state,
        expectedNonce: params.nonce,
      });
      // The web login flow consumes the ID token as an ID token (the API
      // access-token path never accepts it); a code exchange without one is
      // not a login.
      const claims = tokens.claims();
      if (!claims) {
        throw teamError("UNAUTHENTICATED", "Code exchange returned no ID token");
      }
      const sidClaim =
        (typeof claims.sid === "string" && claims.sid) ||
        (typeof claims.session_state === "string" && claims.session_state) ||
        "";
      const email = typeof claims.email === "string" ? claims.email : "";
      const name =
        typeof claims.name === "string" && claims.name.length > 0
          ? claims.name
          : typeof claims.given_name === "string" && claims.given_name.length > 0
            ? claims.given_name
            : null;
      return {
        claims: {
          sub: typeof claims.sub === "string" ? claims.sub : "",
          sid: sidClaim,
          email,
          emailVerified: claims.email_verified === true,
          preferredUsername:
            typeof claims.preferred_username === "string" && claims.preferred_username.length > 0
              ? claims.preferred_username
              : null,
          displayName: name,
        },
        refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
        accessTokenExpiresAtMs:
          typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 5 * 60_000,
      };
    },

    async refresh(refreshToken) {
      const config = await discover(options);
      const tokens = await oidc.refreshTokenGrant(config, refreshToken);
      const exp = tokens.claims()?.exp;
      return {
        refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
        accessTokenExpiresAtMs: typeof exp === "number" ? exp * 1000 : Date.now() + 5 * 60_000,
      };
    },

    async revoke(refreshToken) {
      try {
        const config = await discover(options);
        await oidc.tokenRevocation(config, refreshToken, { token_type_hint: "refresh_token" });
      } catch {
        // Provider revocation is best effort at logout; local revocation is
        // authoritative (contract C5: app offboarding is immediate).
      }
    },
  };
}
