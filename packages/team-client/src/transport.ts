import {
  API_BASE_PATH,
  EPOCH_HEADER,
  errorBodySchema,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  REQUEST_ID_HEADER,
  TEAM_LIMITS,
} from "@promptbranch/team-contract";
import { isRetryableApiError, TeamApiError, TeamTransportError } from "./errors.js";
import { normalizeTeamOrigin } from "./origin.js";

/**
 * Authenticated HTTP transport for PB-TEAM-1. The origin is normalized once
 * and pinned: every request URL is derived from it, redirects are never
 * followed (C2), and the bearer token is resolved per request so a refreshed
 * token is picked up without rebuilding the client.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Resolves the current bearer token for the pinned origin; null = logged out. */
export type TokenSource = () => string | null | Promise<string | null>;

/** Clock seam so retry backoff is testable without real waiting. */
export interface TeamClock {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const EXPORT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_MAX_RESPONSE_BYTES = TEAM_LIMITS.maxResponsePageBytes;

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function abortedError(message = "The request was cancelled."): TeamTransportError {
  return new TeamTransportError("aborted", message);
}

export const systemClock: TeamClock = {
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
  random: () => Math.random(),
};

export interface TeamTransportOptions {
  origin: string;
  tokenSource?: TokenSource;
  fetchImpl?: FetchLike;
  clock?: TeamClock;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}

export interface TeamRequest {
  method: "GET" | "POST" | "DELETE";
  /** Route path relative to the API base, e.g. `/workspaces/{id}/commands`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Pre-validated body; serialized once so retries reuse identical bytes (C6). */
  body?: unknown;
  auth: "none" | "required";
  /** Discovery and infrastructure routes skip the protocol header (C2). */
  protocolHeader?: boolean;
  /** Workspace writes carry the server epoch (C6). */
  epoch?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TeamHttpResponse {
  status: number;
  requestId: string | null;
  bodyText: string;
}

export interface TeamStreamResponse {
  status: number;
  requestId: string | null;
  response: Response;
  /** Clears the request timeout; the consumer must call this when done. */
  finish: () => void;
  /**
   * Maps a raw body-read failure (abort, timeout, connection reset) onto the
   * typed error surface using the request's abort/timeout state. Typed errors
   * (e.g. response-too-large) pass through unchanged.
   */
  mapReadError: (error: unknown) => TeamTransportError;
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup; the response is being discarded either way.
  }
}

/** Reads a body with the cap enforced before and while reading (C2). */
export async function readBodyBounded(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await cancelQuietly(response);
    throw new TeamTransportError(
      "response-too-large",
      `The response exceeds the ${cap}-byte bound.`,
      response.status,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        exceeded = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (exceeded) await cancelQuietly(response);
    reader.releaseLock();
  }
  if (exceeded) {
    throw new TeamTransportError(
      "response-too-large",
      `The response exceeds the ${cap}-byte bound.`,
      response.status,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
}

export class TeamTransport {
  readonly origin: string;
  private readonly tokenSource?: TokenSource;
  private readonly fetchImpl: FetchLike;
  private readonly clock: TeamClock;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxResponseBytes: number;

  constructor(options: TeamTransportOptions) {
    this.origin = normalizeTeamOrigin(options.origin);
    this.tokenSource = options.tokenSource;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  urlFor(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this.origin}${API_BASE_PATH}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async buildHeaders(spec: TeamRequest, hasBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (spec.protocolHeader !== false) headers[PROTOCOL_HEADER] = String(PROTOCOL_VERSION);
    if (spec.epoch !== undefined) headers[EPOCH_HEADER] = spec.epoch;
    if (hasBody) headers["content-type"] = "application/json";
    if (spec.auth === "required") {
      const token = (await this.tokenSource?.()) ?? null;
      if (token === null || token === "") {
        throw new TeamTransportError(
          "not-authenticated",
          "No credential is available for the pinned team origin.",
        );
      }
      // A token must be a single header-safe token; anything else is a bug in
      // the credential store, not something to send.
      if (!/^[!-~]+$/.test(token)) {
        throw new TeamTransportError(
          "invalid-token",
          "The credential contains characters that are not safe in a header.",
        );
      }
      headers["authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * One attempt: timeout + caller cancellation + redirect refusal. Returns
   * the raw response with a `finish` callback that clears the timeout; for
   * streamed responses the consumer calls `finish` when the stream ends.
   */
  private async send(spec: TeamRequest, bodyText: string | undefined): Promise<TeamStreamResponse> {
    if (spec.signal?.aborted) {
      throw abortedError("The request was cancelled before it was sent.");
    }
    const headers = await this.buildHeaders(spec, bodyText !== undefined);
    const url = this.urlFor(spec.path, spec.query);
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // A stalled request must never keep the process alive on its own.
    timer.unref?.();
    const caller = spec.signal;
    const onAbort = () => controller.abort();
    caller?.addEventListener("abort", onAbort, { once: true });
    // The signal may have fired while the async header build was in flight.
    if (caller?.aborted) {
      clearTimeout(timer);
      caller.removeEventListener("abort", onAbort);
      throw abortedError();
    }
    const finish = () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: bodyText,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      finish();
      if (caller?.aborted) throw abortedError();
      if (timedOut) {
        throw new TeamTransportError(
          "timeout",
          `The team server did not answer within ${timeoutMs} ms.`,
        );
      }
      // Deliberately no cause chaining: transport errors can carry request
      // detail, and error objects never embed request data (C2).
      throw new TeamTransportError("network", "The team server could not be reached.");
    }
    if (isRedirect(response)) {
      finish();
      await cancelQuietly(response);
      // The redirect target is never reported: it is attacker-controlled
      // input that must not end up in logs or be followed with credentials.
      throw new TeamTransportError(
        "redirect-refused",
        "The team server attempted a redirect; redirects are never followed.",
        response.status,
      );
    }
    // Body reads happen after `send` returns, so the abort/timeout state must
    // travel with the response for read failures to be classified correctly:
    // a truncated body is a network failure (C2), not a contract error.
    const mapReadError = (error: unknown): TeamTransportError => {
      if (error instanceof TeamTransportError) return error;
      if (caller?.aborted) return abortedError();
      if (timedOut) {
        return new TeamTransportError(
          "timeout",
          `The team server did not answer within ${timeoutMs} ms.`,
        );
      }
      return new TeamTransportError(
        "network",
        "The connection to the team server dropped mid-response.",
      );
    };
    return {
      status: response.status,
      requestId: response.headers.get(REQUEST_ID_HEADER),
      response,
      finish,
      mapReadError,
    };
  }

  private async toApiError(sent: TeamStreamResponse): Promise<TeamApiError> {
    const { response, requestId } = sent;
    let text: string;
    try {
      text = await readBodyBounded(response, this.maxResponseBytes);
    } catch (error) {
      throw sent.mapReadError(error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TeamTransportError(
        "invalid-response",
        `HTTP ${response.status} with a non-JSON error body.`,
        response.status,
      );
    }
    const body = errorBodySchema.safeParse(parsed);
    if (!body.success) {
      // The raw body is never included: a non-conforming error payload is
      // attacker-influenceable and may carry sensitive bytes.
      throw new TeamTransportError(
        "invalid-response",
        `HTTP ${response.status} with a non-conforming error body.`,
        response.status,
      );
    }
    return new TeamApiError(
      body.data.error.code,
      body.data.error.message,
      response.status,
      body.data.error.requestId ?? requestId,
      body.data.error.retryable,
      body.data.error.details,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  private async attemptBuffered(spec: TeamRequest, bodyText: string | undefined): Promise<TeamHttpResponse> {
    const sent = await this.send(spec, bodyText);
    try {
      if (sent.status >= 400) throw await this.toApiError(sent);
      let text: string;
      try {
        text = await readBodyBounded(sent.response, this.maxResponseBytes);
      } catch (error) {
        throw sent.mapReadError(error);
      }
      return { status: sent.status, requestId: sent.requestId, bodyText: text };
    } finally {
      sent.finish();
    }
  }

  /**
   * Buffered JSON request with bounded retry (C2): network failures, timeouts,
   * 503 and RATE_LIMITED are retried with exponential backoff (1–60 s, jittered)
   * honoring Retry-After; 409/422/permission failures are never retried, and
   * retries resend identical bytes so receipt replay deduplicates them (C6).
   */
  async request(spec: TeamRequest): Promise<TeamHttpResponse> {
    const bodyText = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    let retryAfterMs: number | undefined;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
        const delay = retryAfterMs ?? Math.min(MAX_BACKOFF_MS, Math.round(base * (0.5 + this.clock.random())));
        retryAfterMs = undefined;
        await this.clock.sleep(delay, spec.signal);
      }
      try {
        return await this.attemptBuffered(spec, bodyText);
      } catch (error) {
        const retryable =
          error instanceof TeamApiError
            ? isRetryableApiError(error)
            : error instanceof TeamTransportError &&
              (error.reason === "network" || error.reason === "timeout");
        if (error instanceof TeamApiError) retryAfterMs = error.retryAfterMs;
        if (!retryable || attempt + 1 >= this.maxAttempts) throw error;
      }
    }
  }

  /**
   * Opens a streamed response (the owner NDJSON export). Not retried: a
   * partially consumed stream cannot be replayed, so the caller restarts the
   * whole export on failure.
   */
  async openStream(spec: TeamRequest): Promise<TeamStreamResponse> {
    const sent = await this.send(spec, undefined);
    if (sent.status >= 400) {
      try {
        throw await this.toApiError(sent);
      } finally {
        sent.finish();
      }
    }
    return sent;
  }
}
