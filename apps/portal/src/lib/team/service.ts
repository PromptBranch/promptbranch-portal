import {
  SecretBox,
  Sessions,
  createAccessTokenValidator,
  createTeamPool,
  createWebOidcClient,
  type AccessTokenValidator,
  type Pool,
  type Sessions as SessionsClass,
  type WebOidcClient,
} from "@promptbranch/team-server";
import { getTeamEnv, teamEnabled, type TeamEnv } from "./env";

/**
 * Process-wide team service singleton: one pool, one session store, one
 * token validator, one web OIDC client. Cached on globalThis so Next.js dev
 * hot reloads don't leak pools. Built lazily from the current environment;
 * when the team feature is disabled this returns null and every team route
 * answers 503 (a disabled feature registers no usable protected service).
 */

export interface TeamService {
  env: TeamEnv;
  pool: Pool;
  sessions: SessionsClass;
  accessTokenValidator: AccessTokenValidator;
  webOidc: WebOidcClient;
  secretBox: SecretBox;
}

const globalStore = globalThis as { __promptbranchTeamService?: TeamService | null };

export function getTeamService(): TeamService | null {
  if (!teamEnabled()) return null;
  if (globalStore.__promptbranchTeamService !== undefined) {
    return globalStore.__promptbranchTeamService;
  }
  try {
    const env = getTeamEnv();
    const pool = createTeamPool(env.TEAM_DATABASE_URL, { applicationName: "promptbranch-portal-team" });
    const secretBox = SecretBox.fromBase64(env.TEAM_SESSION_ENCRYPTION_KEY);
    const service: TeamService = {
      env,
      pool,
      sessions: new Sessions(pool, secretBox),
      accessTokenValidator: createAccessTokenValidator({
        issuer: env.TEAM_OIDC_ISSUER,
        audience: env.TEAM_OIDC_AUDIENCE,
        allowedClients: [env.TEAM_NATIVE_CLIENT_ID, env.TEAM_CLI_CLIENT_ID],
        jwksJson: env.TEAM_OIDC_JWKS_JSON ? JSON.parse(env.TEAM_OIDC_JWKS_JSON) : undefined,
      }),
      webOidc: createWebOidcClient({
        issuer: env.TEAM_OIDC_ISSUER,
        clientId: env.TEAM_WEB_CLIENT_ID,
        clientSecret: env.TEAM_WEB_CLIENT_SECRET,
      }),
      secretBox,
    };
    globalStore.__promptbranchTeamService = service;
    return service;
  } catch {
    // Fail closed for THIS request; do not cache the failure so a fixed
    // environment recovers without a process restart.
    return null;
  }
}

/** Test hook: drop the cached singleton (pools end with the process). */
export function resetTeamServiceCache(): void {
  const existing = globalStore.__promptbranchTeamService;
  globalStore.__promptbranchTeamService = undefined;
  if (existing) void existing.pool.end().catch(() => undefined);
}
