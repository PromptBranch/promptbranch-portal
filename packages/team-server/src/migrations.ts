import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export interface MigrationOptions {
  /** Connection used to apply migrations; in production the DDL role (`team_migrate`). */
  connectionString: string;
  /** Directory containing forward-only `NNN-name.sql` files. Defaults to the packaged migrations. */
  dir?: URL;
  /**
   * Role granted DML on the migrated schema after each run (the runtime app
   * role, e.g. `team_app`). `null` disables granting.
   */
  appRole?: string | null;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  /** False when `appRole` was configured but absent on the instance. */
  appRolePresent: boolean;
  /** The app role grants were applied for (informational when present). */
  appRole: string | null;
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATION_NAME_PATTERN = /^\d{3}-[a-z0-9-]+\.sql$/;

function defaultMigrationsDir(): URL {
  return new URL("../migrations/", import.meta.url);
}

// Deterministic int64 from the lock name keeps the key identical across
// processes and deployments without a magic literal drifting.
function advisoryLockKey(name: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of Buffer.from(name, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return BigInt.asIntN(64, hash);
}

async function listMigrations(dir: URL): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => MIGRATION_NAME_PATTERN.test(name)).sort();
  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), "utf8");
    migrations.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

async function grantAppRole(client: pg.ClientBase, appRole: string): Promise<boolean> {
  // Only allow plain lowercase identifiers (validated against pg_roles anyway);
  // role names are interpolated because GRANT does not take parameters.
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) return false;
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appRole]);
  if (exists.rowCount === 0) return false;
  await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
  // Future objects created by later migrations also land readable/writable by
  // the app role without re-running manual grants.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
  );
  return true;
}

/**
 * Applies the forward-only migration chain under an advisory lock so concurrent
 * deploy jobs serialize. Applied migrations are checksum-pinned: editing an
 * already-applied file refuses to run (fix forward with a new migration).
 */
export async function runTeamMigrations(options: MigrationOptions): Promise<MigrationResult> {
  const dir = options.dir ?? defaultMigrationsDir();
  const lockKey = advisoryLockKey("promptbranch-team-migrations");
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrations = await listMigrations(dir);
      const applied = new Map<string, string>();
      const rows = await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM team_schema_migrations ORDER BY name",
      );
      for (const row of rows.rows) applied.set(row.name, row.checksum);

      // Forward-only integrity: recorded migrations must still exist with
      // identical content, and pending migrations must extend the chain.
      for (const [name, checksum] of applied) {
        const file = migrations.find((m) => m.name === name);
        if (!file) {
          throw new Error(`migration ${name} is recorded as applied but missing from the package`);
        }
        if (file.checksum !== checksum) {
          throw new Error(`migration ${name} changed after it was applied — fix forward with a new migration`);
        }
      }
      const firstPending = migrations.findIndex((m) => !applied.has(m.name));
      if (firstPending !== -1) {
        for (let i = firstPending; i < migrations.length; i++) {
          if (applied.has(migrations[i]?.name as string)) {
            throw new Error(`migration gap: ${migrations[i]?.name} is out of order (forward-only chain)`);
          }
        }
      }

      const result: MigrationResult = {
        applied: [],
        alreadyApplied: [],
        appRolePresent: true,
        appRole: options.appRole ?? null,
      };

      for (const migration of migrations) {
        if (applied.has(migration.name)) {
          result.alreadyApplied.push(migration.name);
          continue;
        }
        await client.query("BEGIN");
        try {
          // Simple query protocol: a migration file may contain many statements.
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO team_schema_migrations (name, checksum) VALUES ($1, $2)",
            [migration.name, migration.checksum],
          );
          await client.query("COMMIT");
          result.applied.push(migration.name);
        } catch (error) {
          await client.query("ROLLBACK");
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`migration ${migration.name} failed: ${message}`, { cause: error });
        }
      }

      if (options.appRole) {
        result.appRolePresent = await grantAppRole(client, options.appRole);
      }
      return result;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [lockKey])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/** Shared default for callers that need the packaged migrations directory explicitly. */
export function packagedMigrationsDir(): URL {
  return defaultMigrationsDir();
}
