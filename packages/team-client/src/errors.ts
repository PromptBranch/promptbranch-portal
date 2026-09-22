/**
 * Typed client errors. Both classes are redacted by construction: neither
 * ever carries request/response bodies, redirect targets or tokens. A
 * `TeamApiError` echoes only the server's contract error body (C2), whose
 * message/details are server-authored and never contain matched secrets; a
 * `TeamTransportError` describes a client-side failure category and status.
 */

/** Why a request failed before a contract error body could be honored. */
export type TeamTransportErrorReason =
  | "invalid-request"
  | "not-authenticated"
  | "invalid-token"
  | "network"
  | "timeout"
  | "aborted"
  | "redirect-refused"
  | "invalid-json"
  | "invalid-response"
  | "response-too-large"
  | "unsupported-server";

/** A server-reported contract error: `{ error: { code, ... } }` (C2). */
export class TeamApiError extends Error {
  override readonly name = "TeamApiError";

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    /** Parsed Retry-After hint in milliseconds, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A client-side failure: transport, cancellation, bounds or validation. */
export class TeamTransportError extends Error {
  override readonly name = "TeamTransportError";

  constructor(
    readonly reason: TeamTransportErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isRetryableApiError(error: TeamApiError): boolean {
  // C2: network/503/RATE_LIMITED are retryable; QUOTA_EXCEEDED is not despite
  // its 429 status, and 409/422/permission failures are never retried.
  if (error.code === "QUOTA_EXCEEDED") return false;
  if (error.code === "RATE_LIMITED" || error.code === "UNAVAILABLE") return true;
  return error.retryable && (error.status === 429 || error.status === 503 || error.status >= 500);
}
