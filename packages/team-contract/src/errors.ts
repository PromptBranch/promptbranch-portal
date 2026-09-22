import { z } from "zod";

/**
 * Stable error codes from C2. `errorCodeSchema` enumerates the codes defined
 * by protocol v1; `errorBodySchema` accepts any non-empty code string so
 * clients tolerate codes introduced by later additive contract versions.
 */
export const ERROR_CODES = [
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
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** Codes the client may retry (C2); QUOTA_EXCEEDED stays nonretryable on 429. */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = [
  "RATE_LIMITED",
  "UNAVAILABLE",
];

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
