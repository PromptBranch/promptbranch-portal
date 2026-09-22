import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REQUIRED_FEATURES, TEAM_LIMITS, type TeamInfo } from "@promptbranch/team-contract";
import {
  beginDeviceAuthorization,
  beginNativeAuthorization,
  completeNativeAuthorization,
  createMemoryTeamCredentialStore,
  createTeamSessionManager,
  discoverTeamIssuer,
  isLoopbackRemoteAddress,
  pollDeviceAuthorization,
  startLoopbackCallbackServer,
  teamAccountKey,
  TeamAuthError,
  type TeamAccountProfile,
} from "../src/oidc.js";

/**
 * Loopback stub IdP + team server in one HTTP server: OIDC discovery,
 * authorize, token (code/refresh/device grants), device authorization, JWKS,
 * revocation, plus the team /info and /me endpoints. RS256 ID tokens are
 * signed with a real generated key so openid-client performs genuine
 * signature and claim validation.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = {
  ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: "stub-key",
  alg: "RS256",
  use: "sig",
};

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_EPOCH = "22222222-2222-4222-8222-222222222222";
const NATIVE_CLIENT_ID = "promptbranch-desktop";
const CLI_CLIENT_ID = "promptbranch-cli";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "idp-subject-1";
const SESSION_ID = "idp-session-1";
const EMAIL = "pilot@example.test";

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

interface IdTokenKnobs {
  iss?: string;
  aud?: string;
  nonce?: string | null;
  sid?: string | null;
  sub?: string;
  emailVerified?: boolean;
}

interface StubState {
  /** Seconds of access-token lifetime issued by the token endpoint. */
  accessExpiresIn: number;
  /** Extra latency on the refresh grant, for refresh-serialization tests. */
  refreshDelayMs: number;
  /** Popped per device-grant poll. */
  deviceScript: string[];
  deviceInterval: number;
  deviceExpiresIn: number;
  /** ID token claim overrides for negative tests. */
  idToken: IdTokenKnobs;
  /** Discovery document issuer override (issuer-mismatch test). */
  discoveryIssuerOverride: string | null;
}

const state: StubState = {
  accessExpiresIn: 300,
  refreshDelayMs: 0,
  deviceScript: [],
  deviceInterval: 1,
  deviceExpiresIn: 120,
  idToken: {},
  discoveryIssuerOverride: null,
};

const counters = {
  tokenCalls: 0,
  refreshCalls: 0,
  deviceCalls: 0,
};

interface IssuedCode {
  challenge: string;
  nonce: string | null;
  clientId: string;
}

const codes = new Map<string, IssuedCode>();
const refreshTokens = new Map<string, { sub: string; active: boolean }>();
const accessTokens = new Map<string, string>();
const deviceCodes = new Map<string, { clientId: string }>();

let server: http.Server;
let origin: string;
let issuer: string;

function infoPayload(): TeamInfo {
  return {
    protocol: 1,
    contractVersion: "1.0.0",
    serverId: SERVER_ID,
    serverEpoch: SERVER_EPOCH,
    features: [...REQUIRED_FEATURES],
    issuer,
    nativeClientId: NATIVE_CLIENT_ID,
    cliClientId: CLI_CLIENT_ID,
    audience: "promptbranch-team-api",
    limits: { ...TEAM_LIMITS },
  };
}

function signIdToken(clientId: string, nonce: string | null): string {
  const now = Math.floor(Date.now() / 1000);
  const knobs = state.idToken;
  const payload: Record<string, unknown> = {
    iss: knobs.iss ?? issuer,
    sub: knobs.sub ?? SUBJECT,
    aud: knobs.aud ?? clientId,
    exp: now + 300,
    iat: now,
    auth_time: now,
    email: EMAIL,
    email_verified: knobs.emailVerified ?? true,
  };
  if (nonce !== null) payload.nonce = nonce;
  if (knobs.nonce !== undefined) {
    if (knobs.nonce === null) delete payload.nonce;
    else payload.nonce = knobs.nonce;
  }
  const sid = knobs.sid === undefined ? SESSION_ID : knobs.sid;
  if (sid !== null) payload.sid = sid;
  const header = base64url({ alg: "RS256", kid: "stub-key", typ: "JWT" });
  const body = base64url(payload);
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${body}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${body}.${signature}`;
}

function issueTokens(clientId: string, nonce: string | null): Record<string, unknown> {
  const accessToken = `at_${randomUUID()}`;
  const refreshToken = `rt_${randomUUID()}`;
  accessTokens.set(accessToken, SUBJECT);
  refreshTokens.set(refreshToken, { sub: SUBJECT, active: true });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: state.accessExpiresIn,
    refresh_token: refreshToken,
    id_token: signIdToken(clientId, nonce),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function handleTokenGrant(form: URLSearchParams, res: http.ServerResponse): void {
  counters.tokenCalls += 1;
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  if (grantType === "authorization_code") {
    const code = codes.get(form.get("code") ?? "");
    if (!code || code.clientId !== clientId) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    codes.delete(form.get("code")!);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== code.challenge) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    json(res, 200, issueTokens(clientId, code.nonce));
    return;
  }
  if (grantType === "refresh_token") {
    counters.refreshCalls += 1;
    const finish = () => {
      const record = refreshTokens.get(form.get("refresh_token") ?? "");
      if (!record || !record.active) {
        json(res, 400, { error: "invalid_grant" });
        return;
      }
      // Rotation: the presented refresh token dies with this response.
      record.active = false;
      const tokens = issueTokens(clientId, null);
      const payload: Record<string, unknown> = { ...tokens };
      if (state.idToken.sub !== undefined) {
        payload.id_token = signIdToken(clientId, null);
      }
      json(res, 200, payload);
    };
    if (state.refreshDelayMs > 0) setTimeout(finish, state.refreshDelayMs);
    else finish();
    return;
  }
  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    const device = deviceCodes.get(form.get("device_code") ?? "");
    if (!device || device.clientId !== clientId) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    const step = state.deviceScript.shift() ?? "authorization_pending";
    if (step === "approve") {
      deviceCodes.delete(form.get("device_code")!);
      json(res, 200, issueTokens(clientId, null));
    } else {
      json(res, 400, { error: step });
    }
    return;
  }
  json(res, 400, { error: "unsupported_grant_type" });
}

const requestHandler: http.RequestListener = (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  void (async () => {
    if (url.pathname === "/api/team/v1/info") {
      json(res, 200, infoPayload());
      return;
    }
    if (url.pathname === "/api/team/v1/me") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const sub = accessTokens.get(token);
      if (!sub) {
        json(res, 401, {
          error: { code: "UNAUTHENTICATED", message: "nope", requestId: randomUUID(), retryable: false },
        });
        return;
      }
      json(res, 200, { user: { id: USER_ID, displayName: "Pilot User", email: EMAIL }, workspaces: [] });
      return;
    }
    if (url.pathname === "/idp/.well-known/openid-configuration") {
      const advertised = state.discoveryIssuerOverride ?? issuer;
      json(res, 200, {
        issuer: advertised,
        authorization_endpoint: `${advertised}/authorize`,
        token_endpoint: `${advertised}/token`,
        device_authorization_endpoint: `${advertised}/device`,
        revocation_endpoint: `${advertised}/revoke`,
        jwks_uri: `${advertised}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
      });
      return;
    }
    if (url.pathname === "/idp/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      if (!redirectUri.startsWith("http://127.0.0.1:")) {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = `code_${randomUUID()}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce"),
        clientId: url.searchParams.get("client_id") ?? "",
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.statusCode = 302;
      res.setHeader("location", target.toString());
      res.end();
      return;
    }
    if (url.pathname === "/idp/token" && req.method === "POST") {
      handleTokenGrant(await readForm(req), res);
      return;
    }
    if (url.pathname === "/idp/device" && req.method === "POST") {
      counters.deviceCalls += 1;
      const form = await readForm(req);
      const deviceCode = `dc_${randomUUID()}`;
      deviceCodes.set(deviceCode, { clientId: form.get("client_id") ?? "" });
      json(res, 200, {
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: `${issuer}/verify`,
        verification_uri_complete: `${issuer}/verify?user_code=ABCD-EFGH`,
        expires_in: state.deviceExpiresIn,
        interval: state.deviceInterval,
      });
      return;
    }
    if (url.pathname === "/idp/jwks") {
      json(res, 200, { keys: [PUBLIC_JWK] });
      return;
    }
    if (url.pathname === "/idp/revoke" && req.method === "POST") {
      const form = await readForm(req);
      const record = refreshTokens.get(form.get("token") ?? "");
      if (record) record.active = false;
      res.statusCode = 200;
      res.end();
      return;
    }
    json(res, 404, { error: "not_found" });
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
};

beforeAll(async () => {
  server = http.createServer(requestHandler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  issuer = `${origin}/idp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.accessExpiresIn = 300;
  state.refreshDelayMs = 0;
  state.deviceScript = [];
  state.deviceInterval = 1;
  state.deviceExpiresIn = 120;
  state.idToken = {};
  state.discoveryIssuerOverride = null;
  counters.tokenCalls = 0;
  counters.refreshCalls = 0;
  counters.deviceCalls = 0;
  codes.clear();
  refreshTokens.clear();
  accessTokens.clear();
  deviceCodes.clear();
});

/** Runs the whole browser flow against the stub: listener + authorize + grant. */
async function performStubLogin(clientId = NATIVE_CLIENT_ID) {
  const info = infoPayload();
  const config = await discoverTeamIssuer(info, clientId);
  const listener = await startLoopbackCallbackServer({ timeoutMs: 5_000 });
  try {
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: listener.redirectUri,
    });
    const authorizeResponse = await fetch(transaction.authorizationUrl, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);
    const location = authorizeResponse.headers.get("location")!;
    // The browser delivers the callback; the listener answers it.
    void fetch(location).catch(() => {});
    const callbackUrl = await listener.waitForCallback();
    const tokens = await completeNativeAuthorization(config, transaction, callbackUrl);
    return { config, listener, tokens };
  } finally {
    await listener.close();
  }
}

function profileFromTokens(tokens: {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
}): TeamAccountProfile {
  return {
    origin,
    serverId: SERVER_ID,
    issuer,
    clientId: NATIVE_CLIENT_ID,
    userId: USER_ID,
    subject: SUBJECT,
    sessionId: SESSION_ID,
    displayName: "Pilot User",
    email: EMAIL,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    updatedAt: new Date().toISOString(),
  };
}

describe("discoverTeamIssuer", () => {
  it("discovers endpoints and validates the issuer", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const metadata = config.serverMetadata();
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.token_endpoint).toBe(`${issuer}/token`);
    expect(metadata.device_authorization_endpoint).toBe(`${issuer}/device`);
  });

  it("rejects a discovery document whose issuer does not match", async () => {
    state.discoveryIssuerOverride = `${issuer}/elsewhere`;
    await expect(discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID)).rejects.toMatchObject({
      code: "AUTH_ISSUER",
    });
  });

  it("rejects plain-HTTP issuers off loopback before any network I/O", async () => {
    const info = { ...infoPayload(), issuer: "http://203.0.113.10/idp" };
    await expect(discoverTeamIssuer(info, NATIVE_CLIENT_ID)).rejects.toMatchObject({
      code: "AUTH_ISSUER",
    });
  });

  it("maps an unreachable issuer to AUTH_DISCOVERY", async () => {
    const info = { ...infoPayload(), issuer: "http://127.0.0.1:1/idp" };
    await expect(discoverTeamIssuer(info, NATIVE_CLIENT_ID)).rejects.toMatchObject({
      code: "AUTH_DISCOVERY",
    });
  });
});

describe("native code+PKCE flow", () => {
  it("completes a full browser login against the stub IdP", async () => {
    const { tokens } = await performStubLogin();
    expect(tokens.accessToken).toMatch(/^at_/);
    expect(tokens.refreshToken).toMatch(/^rt_/);
    expect(tokens.subject).toBe(SUBJECT);
    expect(tokens.sessionId).toBe(SESSION_ID);
    expect(tokens.email).toBe(EMAIL);
    expect(tokens.accessTokenExpiresAt).not.toBeNull();
  });

  it("sends an S256 PKCE challenge and loopback redirect", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const url = new URL(transaction.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(transaction.codeVerifier).digest("base64url"),
    );
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/callback");
    expect(url.searchParams.get("client_id")).toBe(NATIVE_CLIENT_ID);
    expect(url.searchParams.get("state")).toBe(transaction.state);
    expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("rejects a callback with the wrong state as AUTH_STATE", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const wrongStateCallback = `http://127.0.0.1:9/callback?code=code_x&state=wrong-${randomUUID()}`;
    await expect(
      completeNativeAuthorization(config, transaction, wrongStateCallback),
    ).rejects.toMatchObject({ code: "AUTH_STATE" });
  });

  it("rejects a callback with no state as AUTH_STATE", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    await expect(
      completeNativeAuthorization(config, transaction, "http://127.0.0.1:9/callback?code=code_x"),
    ).rejects.toMatchObject({ code: "AUTH_STATE" });
  });

  it("rejects a tampered nonce as AUTH_NONCE", async () => {
    state.idToken.nonce = "tampered-nonce";
    await expect(performStubLogin()).rejects.toMatchObject({ code: "AUTH_NONCE" });
  });

  it("rejects an ID token from the wrong issuer", async () => {
    state.idToken.iss = `${issuer}/attacker`;
    await expect(performStubLogin()).rejects.toMatchObject({ code: "AUTH_ISSUER" });
  });

  it("rejects an ID token for the wrong audience", async () => {
    state.idToken.aud = "promptbranch-other-client";
    await expect(performStubLogin()).rejects.toMatchObject({ code: "AUTH_AUDIENCE" });
  });

  it("rejects an unverified email as AUTH_TOKEN", async () => {
    state.idToken.emailVerified = false;
    await expect(performStubLogin()).rejects.toMatchObject({ code: "AUTH_TOKEN" });
  });

  it("requires the sid claim", async () => {
    state.idToken.sid = null;
    await expect(performStubLogin()).rejects.toMatchObject({ code: "AUTH_TOKEN" });
  });

  it("maps a PKCE verifier mismatch to AUTH_TOKEN", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const authorizeResponse = await fetch(transaction.authorizationUrl, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location")!;
    const tampered = { ...transaction, codeVerifier: `wrong-${transaction.codeVerifier}` };
    await expect(
      completeNativeAuthorization(config, tampered, location),
    ).rejects.toMatchObject({ code: "AUTH_TOKEN" });
  });

  it("treats the transaction as single-use (duplicate callback)", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const authorizeResponse = await fetch(transaction.authorizationUrl, { redirect: "manual" });
    const location = authorizeResponse.headers.get("location")!;
    await completeNativeAuthorization(config, transaction, location);
    const tokenCalls = counters.tokenCalls;
    // A replayed callback (second delivery of the same redirect) never reaches
    // the token endpoint again.
    const replayed = await fetch(transaction.authorizationUrl, { redirect: "manual" });
    const replayedLocation = replayed.headers.get("location")!;
    await expect(
      completeNativeAuthorization(config, transaction, replayedLocation),
    ).rejects.toMatchObject({ code: "AUTH_CALLBACK" });
    expect(counters.tokenCalls).toBe(tokenCalls);
  });

  it("maps access_denied on the callback to AUTH_CANCELLED", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const callback = `http://127.0.0.1:9/callback?error=access_denied&state=${transaction.state}`;
    await expect(
      completeNativeAuthorization(config, transaction, callback),
    ).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
  });

  it("maps other callback errors to AUTH_CALLBACK", async () => {
    const config = await discoverTeamIssuer(infoPayload(), NATIVE_CLIENT_ID);
    const transaction = await beginNativeAuthorization(config, {
      redirectUri: "http://127.0.0.1:9/callback",
    });
    const callback = `http://127.0.0.1:9/callback?error=server_error&state=${transaction.state}`;
    await expect(
      completeNativeAuthorization(config, transaction, callback),
    ).rejects.toMatchObject({ code: "AUTH_CALLBACK" });
  });
});

describe("loopback callback listener", () => {
  it("binds 127.0.0.1 with an ephemeral port and resolves the callback URL", async () => {
    const listener = await startLoopbackCallbackServer({ timeoutMs: 5_000 });
    try {
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const target = `${listener.redirectUri}?code=abc&state=xyz`;
      void fetch(target).catch(() => {});
      const callback = await listener.waitForCallback();
      expect(callback.searchParams.get("code")).toBe("abc");
      expect(callback.searchParams.get("state")).toBe("xyz");
    } finally {
      await listener.close();
    }
  });

  it("times out as AUTH_TIMEOUT and closes the listener", async () => {
    const listener = await startLoopbackCallbackServer({ timeoutMs: 50 });
    await expect(listener.waitForCallback()).rejects.toMatchObject({ code: "AUTH_TIMEOUT" });
    // The port is released: connecting now is refused.
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
  });

  it("cancels as AUTH_CANCELLED on abort", async () => {
    const listener = await startLoopbackCallbackServer({ timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = listener.waitForCallback({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
  });

  it("404s other paths and keeps waiting", async () => {
    const listener = await startLoopbackCallbackServer({ timeoutMs: 5_000 });
    try {
      const root = listener.redirectUri.replace(/\/callback$/, "/");
      const response = await fetch(root);
      expect(response.status).toBe(404);
      const target = `${listener.redirectUri}?code=abc&state=xyz`;
      void fetch(target).catch(() => {});
      const callback = await listener.waitForCallback();
      expect(callback.searchParams.get("code")).toBe("abc");
    } finally {
      await listener.close();
    }
  });

  it("classifies loopback vs LAN remote addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.0.1.5")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.2")).toBe(false);
    expect(isLoopbackRemoteAddress("fd00::1")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});

describe("device authorization grant", () => {
  it("completes after pending polls", { timeout: 15_000 }, async () => {
    state.deviceScript = ["authorization_pending", "authorization_pending", "approve"];
    const config = await discoverTeamIssuer(infoPayload(), CLI_CLIENT_ID);
    const device = await beginDeviceAuthorization(config);
    expect(device.userCode).toBe("ABCD-EFGH");
    expect(device.verificationUriComplete).toContain("user_code=ABCD-EFGH");
    const tokens = await pollDeviceAuthorization(config, device);
    expect(tokens.accessToken).toMatch(/^at_/);
    expect(tokens.subject).toBe(SUBJECT);
  });

  it("honors slow_down and still completes", { timeout: 20_000 }, async () => {
    state.deviceScript = ["slow_down", "authorization_pending", "approve"];
    const config = await discoverTeamIssuer(infoPayload(), CLI_CLIENT_ID);
    const device = await beginDeviceAuthorization(config);
    const tokens = await pollDeviceAuthorization(config, device);
    expect(tokens.accessToken).toMatch(/^at_/);
  });

  it("maps expired_token to AUTH_EXPIRED", async () => {
    state.deviceScript = ["expired_token"];
    const config = await discoverTeamIssuer(infoPayload(), CLI_CLIENT_ID);
    const device = await beginDeviceAuthorization(config);
    await expect(pollDeviceAuthorization(config, device)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("maps access_denied to AUTH_CANCELLED", async () => {
    state.deviceScript = ["access_denied"];
    const config = await discoverTeamIssuer(infoPayload(), CLI_CLIENT_ID);
    const device = await beginDeviceAuthorization(config);
    await expect(pollDeviceAuthorization(config, device)).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
  });

  it("aborts polling as AUTH_CANCELLED", async () => {
    state.deviceInterval = 1;
    state.deviceScript = Array.from({ length: 100 }, () => "authorization_pending");
    const config = await discoverTeamIssuer(infoPayload(), CLI_CLIENT_ID);
    const device = await beginDeviceAuthorization(config);
    const controller = new AbortController();
    const pending = pollDeviceAuthorization(config, device, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
  });
});

describe("teamAccountKey", () => {
  it("namespaces by origin, server and user", () => {
    const key = teamAccountKey({ origin, serverId: SERVER_ID, userId: USER_ID });
    expect(key).toContain(origin);
    expect(key).toContain(SERVER_ID);
    expect(key).toContain(USER_ID);
    expect(
      teamAccountKey({ origin, serverId: SERVER_ID, userId: "other" }),
    ).not.toBe(key);
  });
});

describe("createTeamSessionManager", () => {
  async function seedManager(options?: {
    expiresAt?: string | null;
    now?: () => number;
    leewayMs?: number;
  }) {
    const { config, tokens } = await performStubLogin();
    const store = createMemoryTeamCredentialStore();
    const accountKey = teamAccountKey({ origin, serverId: SERVER_ID, userId: USER_ID });
    const profile = profileFromTokens({
      ...tokens,
      accessTokenExpiresAt: options?.expiresAt === undefined ? tokens.accessTokenExpiresAt : options.expiresAt,
    });
    await store.write(accountKey, profile);
    const manager = createTeamSessionManager({
      config,
      store,
      accountKey,
      ...(options?.now ? { now: options.now } : {}),
      ...(options?.leewayMs !== undefined ? { leewayMs: options.leewayMs } : {}),
    });
    return { config, store, accountKey, manager, tokens };
  }

  it("returns the stored access token while it is fresh (no refresh call)", async () => {
    const { manager, tokens } = await seedManager();
    const token = await manager.tokenSource();
    expect(token).toBe(tokens.accessToken);
    expect(counters.refreshCalls).toBe(0);
  });

  it("refreshes an expired access token and persists the rotated tokens", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager, store, accountKey, tokens } = await seedManager({ expiresAt: past });
    const refreshed = await manager.tokenSource();
    expect(refreshed).toMatch(/^at_/);
    expect(refreshed).not.toBe(tokens.accessToken);
    expect(counters.refreshCalls).toBe(1);
    const stored = await store.read(accountKey);
    expect(stored?.accessToken).toBe(refreshed);
    expect(stored?.refreshToken).toMatch(/^rt_/);
    expect(stored?.refreshToken).not.toBe(tokens.refreshToken);
  });

  it("serializes concurrent refreshes into one token request", async () => {
    state.refreshDelayMs = 100;
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager } = await seedManager({ expiresAt: past });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.tokenSource()),
    );
    expect(counters.refreshCalls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("treats a rejected (rotated-away) refresh token as logged out", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager, store, accountKey, tokens } = await seedManager({ expiresAt: past });
    await manager.tokenSource();
    // Expire the new access token and replay the ORIGINAL refresh token.
    const stored = await store.read(accountKey);
    await store.write(accountKey, {
      ...stored!,
      accessTokenExpiresAt: past,
      refreshToken: tokens.refreshToken,
    });
    const token = await manager.tokenSource();
    expect(token).toBeNull();
    expect(await store.read(accountKey)).toBeNull();
  });

  it("returns null when the access token is expired and no refresh token exists", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager, store, accountKey, tokens } = await seedManager({ expiresAt: past });
    const stored = await store.read(accountKey);
    await store.write(accountKey, { ...stored!, refreshToken: null });
    expect(await manager.tokenSource()).toBeNull();
    expect(tokens.accessToken).toMatch(/^at_/);
  });

  it("returns null when no account is stored", async () => {
    const { manager, store, accountKey } = await seedManager();
    await store.delete(accountKey);
    expect(await manager.tokenSource()).toBeNull();
  });

  it("rejects a refresh whose ID token changes subject", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager } = await seedManager({ expiresAt: past });
    state.idToken.sub = "attacker-subject";
    await expect(manager.tokenSource()).rejects.toMatchObject({ code: "AUTH_TOKEN" });
  });

  it("forceRefresh refreshes even a fresh token, once per call", async () => {
    const { manager, tokens } = await seedManager();
    const refreshed = await manager.forceRefresh();
    expect(refreshed?.accessToken).not.toBe(tokens.accessToken);
    expect(counters.refreshCalls).toBe(1);
  });

  it("logout revokes the refresh token at the provider and deletes the account", async () => {
    const { manager, store, accountKey } = await seedManager();
    const stored = await store.read(accountKey);
    const refreshToken = stored!.refreshToken!;
    await manager.logout();
    expect(await store.read(accountKey)).toBeNull();
    // The revoked refresh token is dead at the provider.
    state.refreshDelayMs = 0;
    const past = new Date(Date.now() - 60_000).toISOString();
    const { manager: other, store: otherStore, accountKey: otherKey } = await seedManager({
      expiresAt: past,
    });
    const otherStored = await otherStore.read(otherKey);
    await otherStore.write(otherKey, { ...otherStored!, refreshToken });
    expect(await other.tokenSource()).toBeNull();
  });
});

describe("createMemoryTeamCredentialStore", () => {
  it("is explicitly session-only and round-trips profiles", async () => {
    const store = createMemoryTeamCredentialStore();
    expect(store.persistent).toBe(false);
    const key = teamAccountKey({ origin, serverId: SERVER_ID, userId: USER_ID });
    expect(await store.read(key)).toBeNull();
    const { tokens } = await performStubLogin();
    await store.write(key, profileFromTokens(tokens));
    expect((await store.read(key))?.accessToken).toBe(tokens.accessToken);
    expect(await store.list()).toEqual([key]);
    await store.delete(key);
    expect(await store.read(key)).toBeNull();
  });
});
