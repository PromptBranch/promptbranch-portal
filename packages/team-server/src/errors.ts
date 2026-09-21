/** Stable team error taxonomy (contract C2) — callers switch on `code`, never message text. */
export const TEAM_ERROR_CODES = [
  "UNAUTHENTICATED",
  "SESSION_REVOKED",
  "WORKSPACE_FORBIDDEN",
  "ROLE_FORBIDDEN",
  "SCOPE_FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "SECRET_BLOCKED",
  "STALE_BASE",
  "STALE_ENTITY",
  "SELF_REVIEW",
  "LAST_OWNER",
  "COMMAND_ID_REUSED",
  "MEMBERSHIP_CHANGED",
  "CURSOR_EXPIRED",
  "SNAPSHOT_EXPIRED",
  "SERVER_EPOCH_CHANGED",
  "PROTOCOL_UNSUPPORTED",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

const HTTP_STATUS: Readonly<Record<TeamErrorCode, { status: number; retryable: boolean }>> = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  SESSION_REVOKED: { status: 401, retryable: false },
  WORKSPACE_FORBIDDEN: { status: 403, retryable: false },
  ROLE_FORBIDDEN: { status: 403, retryable: false },
  SCOPE_FORBIDDEN: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  VALIDATION_FAILED: { status: 422, retryable: false },
  SECRET_BLOCKED: { status: 422, retryable: false },
  STALE_BASE: { status: 409, retryable: false },
  STALE_ENTITY: { status: 409, retryable: false },
  SELF_REVIEW: { status: 409, retryable: false },
  LAST_OWNER: { status: 409, retryable: false },
  COMMAND_ID_REUSED: { status: 409, retryable: false },
  MEMBERSHIP_CHANGED: { status: 409, retryable: false },
  CURSOR_EXPIRED: { status: 410, retryable: false },
  SNAPSHOT_EXPIRED: { status: 410, retryable: false },
  SERVER_EPOCH_CHANGED: { status: 410, retryable: false },
  PROTOCOL_UNSUPPORTED: { status: 426, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  // 429 but not retryable: capacity must be resolved by the user first.
  QUOTA_EXCEEDED: { status: 429, retryable: false },
  UNAVAILABLE: { status: 503, retryable: true },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
};

export interface TeamErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Domain error carrying the contract error code and HTTP mapping. */
export class TeamError extends Error {
  readonly code: TeamErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: TeamErrorCode, message: string, options: TeamErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TeamError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code].status;
    this.retryable = HTTP_STATUS[code].retryable;
    this.details = options.details;
  }
}

export function teamError(code: TeamErrorCode, message: string, options: TeamErrorOptions = {}): TeamError {
  return new TeamError(code, message, options);
}

export function isTeamError(value: unknown): value is TeamError {
  return value instanceof TeamError;
}

/** True when the error is a transient PostgreSQL conflict worth re-running the command (same command ID). */
export function isRetryableSqlError(value: unknown): value is { code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    ((value as { code: unknown }).code === "40001" || (value as { code: unknown }).code === "40P01")
  );
}
