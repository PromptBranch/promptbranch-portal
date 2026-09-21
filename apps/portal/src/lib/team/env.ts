import { z } from "zod";

/**
 * Team-feature environment for the portal (contract C5/C10; full operator
 * set in P9). Parsed on every call — never cached — so tests can mutate
 * process.env. When TEAM_ENABLED the required values must all be present;
 * a misconfigured team feature fails closed (503), never open.
 */

const uuid = z.string().uuid();

const encryptionKey = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "must be base64 for a 256-bit key (32 bytes)",
  });

export const teamEnvSchema = z.object({
  TEAM_ENABLED: z.string().optional(),
  TEAM_DATABASE_URL: z.url(),
  TEAM_SESSION_ENCRYPTION_KEY: encryptionKey,
  TEAM_OIDC_ISSUER: z.url(),
  TEAM_OIDC_AUDIENCE: z.string().min(1).default("promptbranch-team-api"),
  TEAM_WEB_CLIENT_ID: z.string().min(1).default("promptbranch-web"),
  TEAM_WEB_CLIENT_SECRET: z.string().min(1),
  TEAM_NATIVE_CLIENT_ID: z.string().min(1).default("promptbranch-desktop"),
  TEAM_CLI_CLIENT_ID: z.string().min(1).default("promptbranch-cli"),
  TEAM_PUBLIC_ORIGIN: z.url(),
  TEAM_SERVER_ID: uuid,
  TEAM_SERVER_EPOCH: uuid,
  /** Optional dedicated HMAC key for bootstrap page tokens and cursors. */
  TEAM_CURSOR_SIGNING_KEY: z.string().min(16).optional(),
  /** Test-only override: inline JWKS JSON instead of the issuer's endpoint. */
  TEAM_OIDC_JWKS_JSON: z.string().optional(),
});

export type TeamEnv = z.infer<typeof teamEnvSchema>;

export function teamEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.TEAM_ENABLED !== "false";
}

/** Throws a descriptive error when required team values are missing/invalid. */
export function getTeamEnv(source: NodeJS.ProcessEnv = process.env): TeamEnv {
  return teamEnvSchema.parse({
    TEAM_ENABLED: source.TEAM_ENABLED,
    TEAM_DATABASE_URL: source.TEAM_DATABASE_URL,
    TEAM_SESSION_ENCRYPTION_KEY: source.TEAM_SESSION_ENCRYPTION_KEY,
    TEAM_OIDC_ISSUER: source.TEAM_OIDC_ISSUER,
    TEAM_OIDC_AUDIENCE: source.TEAM_OIDC_AUDIENCE,
    TEAM_WEB_CLIENT_ID: source.TEAM_WEB_CLIENT_ID,
    TEAM_WEB_CLIENT_SECRET: source.TEAM_WEB_CLIENT_SECRET,
    TEAM_NATIVE_CLIENT_ID: source.TEAM_NATIVE_CLIENT_ID,
    TEAM_CLI_CLIENT_ID: source.TEAM_CLI_CLIENT_ID,
    TEAM_PUBLIC_ORIGIN: source.TEAM_PUBLIC_ORIGIN,
    TEAM_SERVER_ID: source.TEAM_SERVER_ID,
    TEAM_SERVER_EPOCH: source.TEAM_SERVER_EPOCH,
    TEAM_CURSOR_SIGNING_KEY: source.TEAM_CURSOR_SIGNING_KEY,
    TEAM_OIDC_JWKS_JSON: source.TEAM_OIDC_JWKS_JSON,
  });
}

export const TEAM_SESSION_COOKIE = "__Host-pb-team";
export const TEAM_AUTH_CORRELATION_COOKIE = "__Host-pb-team-auth";
export const TEAM_CSRF_HEADER = "x-pb-team-csrf";
export const TEAM_PROTOCOL_HEADER = "x-promptbranch-team-protocol";
export const TEAM_PROTOCOL_VERSION = 1;
export const TEAM_CONTRACT_VERSION = "1.0.0";
export const TEAM_FEATURES = ["catalog-v1", "review-v1", "changes-v1", "agent-token-v1"] as const;

/** Wire-level limits from contract C2 — required keys, immutable in protocol v1. */
export const TEAM_LIMITS = {
  maxRequestBytes: 262_144,
  maxResponsePageBytes: 524_288,
  maxContentBytes: 65_536,
  maxPageSize: 100,
  maxMembers: 50,
  maxPrompts: 5_000,
  maxPublishedContentBytes: 209_715_200,
  maxProposals: 50_000,
  maxActiveTokensPerMember: 20,
} as const;
