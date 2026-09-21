import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import pg from "pg";
import { runTeamMigrations, type MigrationResult } from "@promptbranch/team-server/migrations";
import { resetTeamServiceCache } from "@/lib/team/service";

/**
 * Shared fixture for portal team tests: a scratch PostgreSQL database with
 * the migration chain applied, an inline RSA JWKS for signing native access
 * tokens (injected via TEAM_OIDC_JWKS_JSON — test-only override), and the
 * full team env wired into process.env. Each test file gets its own worker
 * process, so the service-singleton cache is naturally isolated.
 */

export const TEST_ISSUER = "http://127.0.0.1:48080/realms/promptbranch-dev";
export const TEST_AUDIENCE = "promptbranch-team-api";
export const TEST_ORIGIN = "http://127.0.0.1:4317";

const DEFAULT_ADMIN_URL = "postgresql://team_admin:team_admin_dev_pw@127.0.0.1:54329/postgres";

function withCredsAndDatabase(url: string, user: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface TeamTestSetup {
  databaseName: string;
  signToken: (claims: Record<string, unknown>, options?: { typ?: string }) => Promise<string>;
  admin: pg.Client;
  pool: pg.Pool;
  cleanup: () => Promise<void>;
}

export async function setupTeamTest(): Promise<TeamTestSetup> {
  const adminUrl = process.env.TEAM_TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect().catch((error) => {
    throw new Error(
      `portal team tests need the local PostgreSQL stack — run \`pnpm team:dev:up\` (${String(error)})`,
    );
  });
  const databaseName = `team_portal_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER team_migrate`);

  let migrations: MigrationResult;
  try {
    migrations = await runTeamMigrations({
      connectionString: withCredsAndDatabase(adminUrl, "team_migrate", "team_migrate_dev_pw", databaseName),
      appRole: "team_app",
    });
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  expectApplied(migrations);

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };
  const now = Math.floor(Date.now() / 1000);
  const signToken = (claims: Record<string, unknown>, options: { typ?: string } = {}) =>
    new SignJWT({ iat: now, exp: now + 300, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", ...(options.typ ? { typ: options.typ } : {}) })
      .sign(privateKey);

  const appUrl = withCredsAndDatabase(adminUrl, "team_app", "team_app_dev_pw", databaseName);
  const pool = new pg.Pool({ connectionString: appUrl, max: 4 });

  process.env.TEAM_DATABASE_URL = appUrl;
  process.env.TEAM_SESSION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.TEAM_OIDC_ISSUER = TEST_ISSUER;
  process.env.TEAM_OIDC_AUDIENCE = TEST_AUDIENCE;
  process.env.TEAM_WEB_CLIENT_ID = "promptbranch-web";
  process.env.TEAM_WEB_CLIENT_SECRET = "test-web-secret";
  process.env.TEAM_NATIVE_CLIENT_ID = "promptbranch-desktop";
  process.env.TEAM_CLI_CLIENT_ID = "promptbranch-cli";
  process.env.TEAM_PUBLIC_ORIGIN = TEST_ORIGIN;
  process.env.TEAM_SERVER_ID = "11111111-1111-4111-8111-111111111111";
  process.env.TEAM_SERVER_EPOCH = "22222222-2222-4222-8222-222222222222";
  process.env.TEAM_OIDC_JWKS_JSON = JSON.stringify(jwks);
  delete process.env.TEAM_ENABLED;

  const cleanup = async () => {
    resetTeamServiceCache();
    await pool.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    delete process.env.TEAM_DATABASE_URL;
    delete process.env.TEAM_SESSION_ENCRYPTION_KEY;
    delete process.env.TEAM_OIDC_ISSUER;
    delete process.env.TEAM_OIDC_JWKS_JSON;
  };

  return { databaseName, signToken, admin, pool, cleanup };
}

function expectApplied(migrations: MigrationResult) {
  if (migrations.applied.length === 0 && migrations.alreadyApplied.length === 0) {
    throw new Error("portal team test setup applied zero migrations");
  }
}

/** Standard native-client claims for a synthetic member. */
export function nativeClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: TEST_ISSUER,
    sub: "alice-sub",
    aud: TEST_AUDIENCE,
    azp: "promptbranch-desktop",
    sid: "provider-sid-alice",
    email: "alice@promptbranch.test",
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000) - 30,
    ...overrides,
  };
}
