/**
 * OIDC authentication for team workspaces (C5), built on openid-client.
 *
 * - Native (desktop) sign-in: external-browser authorization code + S256 PKCE
 *   with state/nonce, delivered to a single-use loopback listener bound to
 *   127.0.0.1 on an ephemeral port (RFC 8252).
 * - CLI sign-in: device authorization grant with interval/slow_down/expiry
 *   handling.
 * - Sessions: a serialized-refresh token source that plugs into the
 *   TeamTransport `tokenSource` seam, plus best-effort provider revocation on
 *   logout.
 *
 * The issuer is always the one advertised by the pinned team origin's `/info`
 * (never user input), and discovery metadata must match it exactly. ID token
 * validation requires a verified email and an `sid`; an ID token is never
 * used as an API access token.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as oidc from "openid-client";
import type { TeamInfo } from "@promptbranch/team-contract";
import { isLoopbackHostname } from "./origin.js";
import type { TokenSource } from "./transport.js";

/** Stable auth failure codes; messages are generic and never carry tokens. */
export type TeamAuthErrorCode =
  | "AUTH_STATE"
  | "AUTH_NONCE"
  | "AUTH_CALLBACK"
  | "AUTH_CANCELLED"
  | "AUTH_TIMEOUT"
  | "AUTH_EXPIRED"
  | "AUTH_ISSUER"
  | "AUTH_AUDIENCE"
  | "AUTH_DISCOVERY"
  | "AUTH_TOKEN"
  | "AUTH_SERVER_IDENTITY";

export class TeamAuthError extends Error {
  override readonly name = "TeamAuthError";

  constructor(
    readonly code: TeamAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A signed-in human account bound to its origin, server identity and user. */
export interface TeamAccountProfile {
  /** Canonical pinned origin (C2). */
  origin: string;
  /** Server identity from /info at login time. */
  serverId: string;
  issuer: string;
  /** The public client used for this login (native or CLI). */
  clientId: string;
  /** Team-server user id from /me (mapped from (issuer, sub) server-side). */
  userId: string;
  /** IdP subject; refreshes must keep belonging to it. */
  subject: string;
  /** OIDC session id (`sid`), required by C5. */
  sessionId: string;
  displayName: string;
  email: string;
  accessToken: string;
  /** RFC3339 expiry from `expires_in`; null when the provider sent none. */
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  updatedAt: string;
}

/** Account namespace: origin + server identity + user (C7 namespacing). */
export function teamAccountKey(parts: {
  origin: string;
  serverId: string;
  userId: string;
}): string {
  return `team|${parts.origin}|${parts.serverId}|${parts.userId}`;
}

/**
 * Protected credential storage. `persistent: false` marks an explicit
 * session-only store (OS protection unavailable); there is deliberately no
 * plaintext-persistent implementation.
 */
export interface TeamCredentialStore {
  readonly persistent: boolean;
  read(accountKey: string): Promise<TeamAccountProfile | null>;
  write(accountKey: string, profile: TeamAccountProfile): Promise<void>;
  delete(accountKey: string): Promise<void>;
  list(): Promise<string[]>;
}

/** In-memory session-only store: the fallback when OS protection is absent. */
export function createMemoryTeamCredentialStore(): TeamCredentialStore {
  const accounts = new Map<string, TeamAccountProfile>();
  return {
    persistent: false,
    read: (accountKey) => Promise.resolve(accounts.get(accountKey) ?? null),
    write: (accountKey, profile) => {
      accounts.set(accountKey, profile);
      return Promise.resolve();
    },
    delete: (accountKey) => {
      accounts.delete(accountKey);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...accounts.keys()]),
  };
}

/** The account survives only while its tokens do; identity fields stay put. */
export type TeamTokenSet = Pick<
  TeamAccountProfile,
  "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "subject" | "sessionId" | "email"
>;

const DEFAULT_SCOPE = "openid profile email offline_access";

/** Refuse a different server identity at a previously used origin (C2). */
export function assertServerIdentity(info: TeamInfo, expectedServerId: string | null): void {
  if (expectedServerId !== null && info.serverId !== expectedServerId) {
    throw new TeamAuthError(
      "AUTH_SERVER_IDENTITY",
      "The team server at this origin presents a different server identity than before; refusing to connect.",
    );
  }
}

// ------------------------------------------------------------------ discovery

export interface DiscoverOptions {
  fetchImpl?: oidc.CustomFetch;
  /** Discovery + endpoint timeout in seconds (default 15). */
  timeoutSeconds?: number;
}

function mapDiscoveryError(error: unknown): TeamAuthError {
  const message = error instanceof Error ? error.message : String(error);
  if (/issuer/i.test(message)) {
    return new TeamAuthError(
      "AUTH_ISSUER",
      "The identity provider's discovery issuer does not match the team server.",
    );
  }
  return new TeamAuthError(
    "AUTH_DISCOVERY",
    "The identity provider's discovery document could not be retrieved.",
  );
}

/**
 * Discovers the issuer advertised by the team server's /info. Plain-HTTP
 * issuers are accepted only on loopback development hosts (matching the C2
 * origin rules); the discovered metadata must echo the advertised issuer
 * exactly, and the endpoints the flows need must be present.
 */
export async function discoverTeamIssuer(
  info: TeamInfo,
  clientId: string,
  options?: DiscoverOptions,
): Promise<oidc.Configuration> {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(info.issuer);
  } catch {
    throw new TeamAuthError("AUTH_ISSUER", "The team server advertises an invalid issuer.");
  }
  if (issuerUrl.protocol === "http:" && !isLoopbackHostname(issuerUrl.hostname)) {
    throw new TeamAuthError(
      "AUTH_ISSUER",
      "Plain-HTTP issuers are only allowed on loopback development addresses.",
    );
  }
  if (issuerUrl.protocol !== "https:" && issuerUrl.protocol !== "http:") {
    throw new TeamAuthError("AUTH_ISSUER", "The team server issuer must use HTTPS.");
  }
  // openid-client is HTTPS-only by default; allowInsecureRequests is enabled
  // solely for loopback development issuers (Keycloak on 127.0.0.1, C10).
  const execute: Array<(config: oidc.Configuration) => void> = [];
  if (issuerUrl.protocol === "http:") execute.push(oidc.allowInsecureRequests);
  const requestOptions: oidc.DiscoveryRequestOptions = {
    timeout: options?.timeoutSeconds ?? 15,
  };
  if (options?.fetchImpl) requestOptions[oidc.customFetch] = options.fetchImpl;
  if (execute.length > 0) requestOptions.execute = execute;
  let config: oidc.Configuration;
  try {
    config = await oidc.discovery(issuerUrl, clientId, undefined, oidc.None(), requestOptions);
  } catch (error) {
    throw mapDiscoveryError(error);
  }
  const metadata = config.serverMetadata();
  if (metadata.issuer !== info.issuer) {
    throw new TeamAuthError(
      "AUTH_ISSUER",
      "The discovered issuer does not match the team server's advertised issuer.",
    );
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new TeamAuthError(
      "AUTH_DISCOVERY",
      "The identity provider's discovery document is incomplete.",
    );
  }
  return config;
}

// ------------------------------------------------------- shared token helpers

function expiryFrom(expiresIn: number | undefined): string | null {
  if (expiresIn === undefined) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * openid-client wraps oauth4webapi claim-validation failures in a generic
 * ClientError; the claim name lives on the cause chain. Walk it.
 */
function errorChainText(error: unknown): string {
  let text = "";
  let current: unknown = error;
  while (current instanceof Error) {
    text += `\n${current.message}`;
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

function mapTokenError(error: unknown): TeamAuthError {
  if (error instanceof TeamAuthError) return error;
  const chain = errorChainText(error);
  if (chain.includes('"nonce"')) {
    return new TeamAuthError(
      "AUTH_NONCE",
      "The identity token did not match this login transaction.",
    );
  }
  if (chain.includes('"iss"')) {
    return new TeamAuthError("AUTH_ISSUER", "The identity token came from an unexpected issuer.");
  }
  if (chain.includes('"aud"') || chain.includes('"azp"')) {
    return new TeamAuthError(
      "AUTH_AUDIENCE",
      "The identity token was issued for a different audience.",
    );
  }
  return new TeamAuthError(
    "AUTH_TOKEN",
    "The identity provider did not complete the token exchange.",
  );
}

function isOAuthError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    (error as { error: unknown }).error === code
  );
}

/**
 * Validates the login token set per C5: an ID token with a verified email and
 * a session id is mandatory. The ID token itself is never returned for API
 * use — only the access token is.
 */
function normalizeLoginTokens(
  tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
): TeamTokenSet {
  const claims = tokens.claims();
  if (!claims) {
    throw new TeamAuthError("AUTH_TOKEN", "The identity provider returned no identity token.");
  }
  if (typeof claims.email !== "string" || claims.email_verified !== true) {
    throw new TeamAuthError(
      "AUTH_TOKEN",
      "The identity provider did not assert a verified email address.",
    );
  }
  if (typeof claims.sid !== "string" || claims.sid === "") {
    throw new TeamAuthError("AUTH_TOKEN", "The identity token carries no session id.");
  }
  return {
    accessToken: tokens.access_token,
    accessTokenExpiresAt: expiryFrom(tokens.expiresIn()),
    refreshToken: tokens.refresh_token ?? null,
    subject: claims.sub,
    sessionId: claims.sid,
    email: claims.email,
  };
}

// --------------------------------------------- native code + PKCE (RFC 8252)

export interface NativeAuthTransaction {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Single-use marker: a completed (or failed) transaction is never reusable. */
const consumedTransactions = new WeakSet<NativeAuthTransaction>();

export async function beginNativeAuthorization(
  config: oidc.Configuration,
  options: { redirectUri: string; scope?: string; audience?: string },
): Promise<NativeAuthTransaction> {
  if (!config.serverMetadata().authorization_endpoint) {
    throw new TeamAuthError(
      "AUTH_DISCOVERY",
      "The identity provider offers no authorization endpoint.",
    );
  }
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const parameters: Record<string, string> = {
    redirect_uri: options.redirectUri,
    scope: options.scope ?? DEFAULT_SCOPE,
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
  };
  if (options.audience) parameters.audience = options.audience;
  const url = oidc.buildAuthorizationUrl(config, parameters);
  return {
    authorizationUrl: url.toString(),
    state,
    nonce,
    codeVerifier,
    redirectUri: options.redirectUri,
  };
}

/**
 * Completes a transaction from the loopback callback URL. State is checked
 * before any network I/O; a transaction completes at most once, so a replayed
 * or duplicated callback never reaches the token endpoint again.
 */
export async function completeNativeAuthorization(
  config: oidc.Configuration,
  transaction: NativeAuthTransaction,
  callbackUrl: string | URL,
  options?: { audience?: string },
): Promise<TeamTokenSet> {
  if (consumedTransactions.has(transaction)) {
    throw new TeamAuthError("AUTH_CALLBACK", "This login transaction was already used.");
  }
  consumedTransactions.add(transaction);
  const url = typeof callbackUrl === "string" ? new URL(callbackUrl) : callbackUrl;
  const errorParam = url.searchParams.get("error");
  if (errorParam !== null) {
    if (errorParam === "access_denied") {
      throw new TeamAuthError("AUTH_CANCELLED", "Sign-in was cancelled.");
    }
    throw new TeamAuthError("AUTH_CALLBACK", `The identity provider returned: ${errorParam}.`);
  }
  if (url.searchParams.get("state") !== transaction.state) {
    throw new TeamAuthError(
      "AUTH_STATE",
      "The sign-in callback state does not match this login transaction.",
    );
  }
  if (!url.searchParams.get("code")) {
    throw new TeamAuthError("AUTH_CALLBACK", "The sign-in callback carried no authorization code.");
  }
  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(
      config,
      url,
      {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
      },
      options?.audience ? { audience: options.audience } : undefined,
    );
  } catch (error) {
    throw mapTokenError(error);
  }
  return normalizeLoginTokens(tokens);
}

// -------------------------------------------------------- loopback listener

export const LOGIN_CALLBACK_PATH = "/callback";
export const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Remote-address check for the callback listener (IPv4/IPv6 loopback only). */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isLoopbackHostname(v4);
}

export interface LoopbackCallbackServer {
  /** The redirect URI to register in the transaction (ephemeral port). */
  redirectUri: string;
  port: number;
  /** Resolves once with the first valid callback URL. */
  waitForCallback(options?: { signal?: AbortSignal }): Promise<URL>;
  close(): Promise<void>;
}

const CALLBACK_HTML =
  "<!doctype html><html><body><p>PromptBranch sign-in complete — you can close this window.</p></body></html>";

/**
 * Single-use loopback listener for the browser callback: bound to 127.0.0.1
 * only, closes after the first valid callback or after the transaction
 * timeout (5 minutes by default). A remote-address check backs the bind as
 * defense in depth; nothing else on the machine can complete the login.
 */
export function startLoopbackCallbackServer(options?: {
  timeoutMs?: number;
}): Promise<LoopbackCallbackServer> {
  const timeoutMs = options?.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS;
  const server = http.createServer();
  let port = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: TeamAuthError) => void;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // The internal promise always has a handler attached by waitForCallback;
  // guard the never-awaited case so a timeout can't crash the process.
  callbackPromise.catch(() => {});

  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    action();
    void close();
  };

  const close = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== LOGIN_CALLBACK_PATH) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      // Unreachable in practice (the socket is bound to 127.0.0.1); refuse
      // anyway so a LAN-delivered callback can never complete a login.
      res.statusCode = 403;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(CALLBACK_HTML);
    settle(() => resolveCallback(new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`)));
  });

  return new Promise<LoopbackCallbackServer>((resolveListen, rejectListen) => {
    server.once("error", () => {
      rejectListen(
        new TeamAuthError("AUTH_CALLBACK", "The loopback sign-in listener could not start."),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      timer = setTimeout(() => {
        settle(() =>
          rejectCallback(new TeamAuthError("AUTH_TIMEOUT", "Sign-in timed out; please try again.")),
        );
      }, timeoutMs);
      // A pending login must never keep the process alive on its own.
      timer.unref?.();
      resolveListen({
        redirectUri: `http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}`,
        port,
        waitForCallback(options) {
          const signal = options?.signal;
          if (!signal) return callbackPromise;
          if (signal.aborted) {
            void close();
            return Promise.reject(new TeamAuthError("AUTH_CANCELLED", "Sign-in was cancelled."));
          }
          return new Promise<URL>((resolve, reject) => {
            callbackPromise.then(resolve, reject);
            signal.addEventListener(
              "abort",
              () => {
                reject(new TeamAuthError("AUTH_CANCELLED", "Sign-in was cancelled."));
                void close();
              },
              { once: true },
            );
          });
        },
        close,
      });
    });
  });
}

// ---------------------------------------------------------- device grant

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
  /** Wall-clock deadline (ms) from the provider's `expires_in`. */
  expiresAtMs: number;
}

export async function beginDeviceAuthorization(
  config: oidc.Configuration,
  options?: { scope?: string; audience?: string; now?: () => number },
): Promise<DeviceAuthorization> {
  if (!config.serverMetadata().device_authorization_endpoint) {
    throw new TeamAuthError(
      "AUTH_DISCOVERY",
      "The identity provider offers no device authorization endpoint.",
    );
  }
  const parameters: Record<string, string> = { scope: options?.scope ?? DEFAULT_SCOPE };
  if (options?.audience) parameters.audience = options.audience;
  let response: oidc.DeviceAuthorizationResponse;
  try {
    response = await oidc.initiateDeviceAuthorization(config, parameters);
  } catch (error) {
    throw mapTokenError(error);
  }
  const now = options?.now?.() ?? Date.now();
  return {
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    verificationUriComplete: response.verification_uri_complete ?? null,
    intervalSeconds: response.interval ?? 5,
    expiresAtMs: now + response.expires_in * 1000,
  };
}

function mapDevicePollError(error: unknown): TeamAuthError {
  if (error instanceof TeamAuthError) return error;
  if (isOAuthError(error, "expired_token")) {
    return new TeamAuthError("AUTH_EXPIRED", "The sign-in code expired; request a new one.");
  }
  if (isOAuthError(error, "access_denied")) {
    return new TeamAuthError("AUTH_CANCELLED", "Sign-in was cancelled.");
  }
  // openid-client normalizes AbortError/TimeoutError into ClientError codes.
  const code = (error as { code?: unknown })?.code;
  if (code === "OAUTH_ABORT" || (error instanceof Error && error.name === "AbortError")) {
    return new TeamAuthError("AUTH_CANCELLED", "Sign-in was cancelled.");
  }
  if (code === "OAUTH_TIMEOUT") {
    return new TeamAuthError("AUTH_EXPIRED", "The sign-in code expired; request a new one.");
  }
  return mapTokenError(error);
}

/**
 * Polls until the user completes device sign-in. Pacing (interval/slow_down)
 * and the expiry deadline are handled by openid-client against the provider's
 * own values; terminal provider errors map onto the auth error codes.
 */
export async function pollDeviceAuthorization(
  config: oidc.Configuration,
  device: DeviceAuthorization,
  options?: { signal?: AbortSignal; audience?: string },
): Promise<TeamTokenSet> {
  const remainingSeconds = Math.max(1, Math.ceil((device.expiresAtMs - Date.now()) / 1000));
  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.pollDeviceAuthorizationGrant(
      config,
      {
        device_code: device.deviceCode,
        user_code: device.userCode,
        verification_uri: device.verificationUri,
        ...(device.verificationUriComplete !== null
          ? { verification_uri_complete: device.verificationUriComplete }
          : {}),
        expires_in: remainingSeconds,
        interval: device.intervalSeconds,
      },
      options?.audience ? { audience: options.audience } : undefined,
      options?.signal ? { signal: options.signal } : undefined,
    );
  } catch (error) {
    throw mapDevicePollError(error);
  }
  return normalizeLoginTokens(tokens);
}

// ----------------------------------------------------------- session manager

export interface TeamSessionManager {
  /** TeamTransport seam: fresh access token, or null when logged out. */
  tokenSource: TokenSource;
  getProfile(): Promise<TeamAccountProfile | null>;
  /**
   * Refresh regardless of expiry (the C2 refresh-once path after a 401).
   * Concurrent callers share one refresh; null means logged out.
   */
  forceRefresh(): Promise<TeamAccountProfile | null>;
  /** Deletes the stored account and revokes the refresh token, best-effort. */
  logout(): Promise<void>;
}

export interface TeamSessionManagerOptions {
  config: oidc.Configuration;
  store: TeamCredentialStore;
  accountKey: string;
  now?: () => number;
  /** Refresh this long before expiry (default 30 s). */
  leewayMs?: number;
}

/**
 * Refresh-once session management. Concurrent tokenSource calls during expiry
 * share a single refresh request (C5 rotation makes parallel refreshes fatal:
 * the loser would replay an already-rotated token). A rejected refresh token
 * — expired, revoked, or rotated away — deletes the stored account: the human
 * must log in again.
 */
export function createTeamSessionManager(options: TeamSessionManagerOptions): TeamSessionManager {
  const now = options.now ?? (() => Date.now());
  const leewayMs = options.leewayMs ?? 30_000;
  let refreshInFlight: Promise<TeamAccountProfile | null> | null = null;

  async function refresh(): Promise<TeamAccountProfile | null> {
    const profile = await options.store.read(options.accountKey);
    if (!profile || !profile.refreshToken) return null;
    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.refreshTokenGrant(options.config, profile.refreshToken);
    } catch (error) {
      if (isOAuthError(error, "invalid_grant")) {
        await options.store.delete(options.accountKey);
        return null;
      }
      throw mapTokenError(error);
    }
    // A refresh response may carry a fresh ID token; it must still belong to
    // the same subject that logged in.
    const claims = tokens.claims();
    if (claims && claims.sub !== profile.subject) {
      throw new TeamAuthError(
        "AUTH_TOKEN",
        "The refreshed session belongs to a different identity.",
      );
    }
    const next: TeamAccountProfile = {
      ...profile,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: expiryFrom(tokens.expiresIn()),
      refreshToken: tokens.refresh_token ?? profile.refreshToken,
      updatedAt: new Date(now()).toISOString(),
    };
    await options.store.write(options.accountKey, next);
    return next;
  }

  function refreshOnce(): Promise<TeamAccountProfile | null> {
    refreshInFlight ??= refresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function isFresh(profile: TeamAccountProfile): boolean {
    if (profile.accessTokenExpiresAt === null) return true;
    return Date.parse(profile.accessTokenExpiresAt) - leewayMs > now();
  }

  return {
    tokenSource: async () => {
      const profile = await options.store.read(options.accountKey);
      if (!profile) return null;
      if (isFresh(profile)) return profile.accessToken;
      const refreshed = await refreshOnce();
      return refreshed?.accessToken ?? null;
    },
    getProfile: () => options.store.read(options.accountKey),
    forceRefresh: () => refreshOnce(),
    async logout() {
      const profile = await options.store.read(options.accountKey);
      await options.store.delete(options.accountKey);
      if (profile?.refreshToken && options.config.serverMetadata().revocation_endpoint) {
        try {
          await oidc.tokenRevocation(options.config, profile.refreshToken);
        } catch {
          // Revocation is best-effort; the local credential is already gone.
        }
      }
    },
  };
}
