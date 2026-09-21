import { z } from "zod";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// URL");

export const teamServerConfigSchema = z.object({
  /** DML-role connection used by the running application. */
  databaseUrl: postgresUrl,
  /**
   * DDL-role connection used exclusively by the migration runner. Defaults to
   * `databaseUrl` for simple single-role deployments (e.g. scratch test
   * databases); production splits the roles.
   */
  migrationDatabaseUrl: postgresUrl.optional(),
  /**
   * Role that receives DML grants after each migration run. `null` disables
   * granting (single-role deployments where the migration role is also the
   * app role).
   */
  appDbRole: z.string().regex(/^[a-z_][a-z0-9_]*$/).nullable().default("team_app"),
  poolMax: z.coerce.number().int().positive().max(100).default(10),
});

export type TeamServerConfig = z.infer<typeof teamServerConfigSchema>;

export interface ParsedTeamEnv {
  databaseUrl: string;
  migrationDatabaseUrl?: string;
  appDbRole: string | null;
  poolMax: number;
}

/**
 * Zod-parses team env on every call (never cached) so tests and workers can
 * mutate `process.env`. `TEAM_ENABLED` gating and the remaining operator env
 * (OIDC, keys, SMTP) arrive with P2/P9; P1 only needs database access.
 */
export function parseTeamEnv(env: NodeJS.ProcessEnv = process.env): ParsedTeamEnv {
  const raw = {
    databaseUrl: env.TEAM_DATABASE_URL,
    migrationDatabaseUrl: env.TEAM_MIGRATION_DATABASE_URL,
    appDbRole: env.TEAM_DB_APP_ROLE === undefined ? undefined : env.TEAM_DB_APP_ROLE === "" ? null : env.TEAM_DB_APP_ROLE,
    poolMax: env.TEAM_DB_POOL_MAX,
  };
  const parsed = teamServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid team server configuration (set TEAM_DATABASE_URL etc.): ${issues}`);
  }
  return parsed.data;
}
