import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createTeamPool, type Pool } from "../src/db.js";
import { runTeamMigrations, packagedMigrationsDir, type MigrationResult } from "../src/migrations.js";
import { withWorkspaceTransaction, type WorkspaceTransactionOptions, type WorkspaceTx } from "../src/tx.js";
import { SecretBox } from "../src/auth/crypto.js";
import type { Principal, Scope } from "../src/auth/principal.js";
import { executeTeamCommand, type DispatchSuccess } from "../src/commands/dispatch.js";
import { createWorkspace, type WorkspaceDto } from "../src/domain/workspaces.js";
import { acceptInvitation } from "../src/domain/invitations.js";

/**
 * Real-PostgreSQL test harness (plan P1). Every suite gets its own scratch
 * database with the full forward-only migration chain applied, an app-role
 * pool (DML only — role separation is exercised, not bypassed), a dedicated
 * raw connection for concurrency races, and seed/factory helpers. Services
 * built on later phases run against this same harness; SQLite never
 * substitutes for PostgreSQL.
 */

/** Local dev stack defaults (deploy/team/.env.example); override via env for CI. */
const DEFAULT_ADMIN_URL = "postgresql://team_admin:team_admin_dev_pw@127.0.0.1:54329/postgres";
const DEFAULT_MIGRATION_USER = "team_migrate";
const DEFAULT_MIGRATION_PASSWORD = "team_migrate_dev_pw";
const DEFAULT_APP_USER = "team_app";
const DEFAULT_APP_PASSWORD = "team_app_dev_pw";
/** Synthetic development issuer matching deploy/team/realm.dev.json. */
export const DEV_ISSUER = "http://127.0.0.1:48080/realms/promptbranch-dev";

export type HumanPrincipal = Extract<Principal, { kind: "human" }>;
export type AgentPrincipal = Extract<Principal, { kind: "agent" }>;

export interface HarnessUser {
  userId: string;
  sessionId: string;
  email: string;
  principal: HumanPrincipal;
}

export interface HarnessAgent {
  tokenId: string;
  ownerUserId: string;
  scopes: Scope[];
  principal: AgentPrincipal;
}

export interface HarnessWorkspace {
  workspaceId: string;
  generation: string;
  serverEpoch: string;
}

export interface HarnessPrompt {
  promptId: string;
  title: string;
}

export interface HarnessRevision {
  revisionId: string;
  contentHash: string;
}

/** Minimal P1 service surface; later phases extend this with domain operations. */
export interface HarnessService {
  withWorkspaceTransaction<T>(
    options: WorkspaceTransactionOptions,
    fn: (work: WorkspaceTx) => Promise<T>,
  ): Promise<T>;
  execute(principal: Principal, workspaceId: string, epoch: string, envelope: unknown): Promise<DispatchSuccess>;
  createWorkspace(principal: HumanPrincipal, input: { commandId: string; name: string }): Promise<{ workspace: WorkspaceDto; created: boolean }>;
  acceptInvitation(principal: HumanPrincipal, input: { commandId: string; token: string }): Promise<{ workspace: WorkspaceDto & { role: string }; accepted: boolean }>;
}

export interface TeamTestHarnessOptions {
  /** Include-list applied to the migration chain (upgrade-path tests). */
  includeMigrations?: RegExp;
  appRole?: string | null;
}

const COUNTABLE_TABLES = new Set([
  "team_users",
  "team_sessions",
  "team_web_sessions",
  "team_workspaces",
  "team_memberships",
  "team_invitations",
  "team_tags",
  "team_collections",
  "team_agent_tokens",
  "team_prompts",
  "team_revisions",
  "team_publications",
  "team_proposals",
  "team_reviews",
  "team_prompt_tags",
  "team_collection_prompts",
  "team_comments",
  "team_activity_items",
  "team_prompt_search",
  "team_changes",
  "team_bootstraps",
  "team_bootstrap_rows",
  "team_command_receipts",
  "team_user_receipts",
  "team_audit",
  "team_jobs",
  "team_rate_buckets",
  "team_schema_migrations",
]);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withCredsAndDatabase(url: string, user: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let harnessCounter = 0;

export interface TeamTestHarness {
  /** DML-role pool used by the service under test. */
  pool: Pool;
  /** Admin pool (scratch database lifecycle). */
  adminPool: Pool;
  /** Dedicated connection for concurrency races (holds locks across awaits). */
  raw: pg.Client;
  /** The synthetic key the service facade seals job payloads with. */
  secretBox: SecretBox;
  databaseName: string;
  migrationResult: MigrationResult;
  service: HarnessService;
  asUser(name: string, options?: { workspaceId?: string; role?: string }): Promise<HarnessUser>;
  asAgent(name: string, ownerUserId: string, options?: { scopes?: Scope[]; workspaceId?: string }): Promise<HarnessAgent>;
  createWorkspace(name: string, ownerUserId: string): Promise<HarnessWorkspace>;
  seedPrompt(workspaceId: string, options?: { title?: string; description?: string }): Promise<HarnessPrompt>;
  seedRevision(
    workspaceId: string,
    promptId: string,
    options?: { content?: string; changeNote?: string; authorUserId?: string; parentRevisionId?: string },
  ): Promise<HarnessRevision>;
  publishRevision(workspaceId: string, promptId: string, revisionId: string): Promise<void>;
  insertCrossWorkspaceCandidate(): Promise<never>;
  count(table: string): Promise<number>;
  /** The synthetic verified email `asUser(name)` maps to. */
  emailFor(name: string): string;
  migrate(options?: { dir?: URL }): Promise<MigrationResult>;
  /** Runs SQL as the DDL role against the scratch database (e.g. tamper checks). */
  withMigrationClient(fn: (client: pg.ClientBase) => Promise<unknown>): Promise<void>;
  close(): Promise<void>;
}

export async function createTeamTestHarness(
  options: TeamTestHarnessOptions = {},
): Promise<TeamTestHarness> {
  const adminUrl = process.env.TEAM_TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const migrationUser = process.env.TEAM_TEST_MIGRATION_USER ?? DEFAULT_MIGRATION_USER;
  const migrationPassword = process.env.TEAM_TEST_MIGRATION_PASSWORD ?? DEFAULT_MIGRATION_PASSWORD;
  const appUser = process.env.TEAM_TEST_APP_USER ?? DEFAULT_APP_USER;
  const appPassword = process.env.TEAM_TEST_APP_PASSWORD ?? DEFAULT_APP_PASSWORD;
  const appRole = options.appRole === undefined ? (process.env.TEAM_TEST_APP_ROLE ?? "team_app") : options.appRole;

  const adminPool = new pg.Pool({ connectionString: adminUrl, max: 2, connectionTimeoutMillis: 4_000 });
  try {
    await adminPool.query("SELECT 1");
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    const target = new URL(adminUrl);
    throw new Error(
      `team test harness: PostgreSQL is not reachable at ${target.host} — run \`pnpm team:dev:up\` first ` +
        `or set TEAM_TEST_DATABASE_URL (cause: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const databaseName = `team_test_${Date.now().toString(36)}_${process.pid.toString(36)}_${harnessCounter++}_${randomUUID().slice(0, 8)}`;
  // The migration role must own the scratch database: since PostgreSQL 15
  // only the owner can create objects in the public schema, and the runner
  // connects exclusively as the DDL role (mirrors the production split).
  const ownerRole = process.env.TEAM_TEST_DATABASE_OWNER ?? migrationUser;
  await adminPool.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);

  let migrationDir: URL | undefined;
  let migrationTempDir: string | undefined;
  if (options.includeMigrations) {
    // Copy only the matching migration files so the suite can start from a
    // prefix of the chain and later upgrade to the full set.
    const sourceDir = new URL("../migrations/", import.meta.url);
    migrationTempDir = await mkdtemp(join(tmpdir(), "team-migrations-"));
    for (const file of (await readdir(sourceDir)).filter((f) => options.includeMigrations?.test(f))) {
      await copyFile(new URL(file, sourceDir), join(migrationTempDir, file));
    }
    migrationDir = pathToFileURL(`${migrationTempDir}/`);
  }

  const migrationUrl = withCredsAndDatabase(adminUrl, migrationUser, migrationPassword, databaseName);
  const appUrl = withCredsAndDatabase(adminUrl, appUser, appPassword, databaseName);

  let migrationResult: MigrationResult;
  try {
    migrationResult = await runTeamMigrations({
      connectionString: migrationUrl,
      dir: migrationDir,
      appRole,
    });
  } catch (error) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end().catch(() => undefined);
    throw error;
  }

  const pool = createTeamPool(appUrl, { applicationName: "team-server-test" });
  const raw = new pg.Client(appUrl);
  await raw.connect();

  const secretBox = new SecretBox(Buffer.alloc(32, 7)); // synthetic test key
  const dispatchOptions = { pool, secretBox, publicOrigin: "http://127.0.0.1:4317" };

  let closed = false;

  async function ensureUser(displayName: string): Promise<{ userId: string; email: string }> {
    const subject = `synthetic-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    const email = `${subject}@promptbranch.test`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (issuer, subject) DO NOTHING
       RETURNING id`,
      [DEV_ISSUER, subject, email, displayName],
    );
    const row = inserted.rows[0]
      ? inserted.rows[0]
      : (
          await pool.query<{ id: string }>(
            "SELECT id FROM team_users WHERE issuer = $1 AND subject = $2",
            [DEV_ISSUER, subject],
          )
        ).rows[0];
    if (!row) throw new Error(`harness: could not create user ${displayName}`);
    return { userId: row.id, email };
  }

  const harness: TeamTestHarness = {
    pool,
    adminPool,
    raw,
    secretBox,
    databaseName,
    migrationResult,

    service: {
      withWorkspaceTransaction: (txOptions, fn) => withWorkspaceTransaction(pool, txOptions, fn),
      execute: (principal, workspaceId, epoch, envelope) =>
        executeTeamCommand(dispatchOptions, principal, workspaceId, epoch, envelope),
      createWorkspace: (principal, input) => createWorkspace(pool, principal, input),
      acceptInvitation: (principal, input) =>
        acceptInvitation(pool, { principal, secretBox, publicOrigin: dispatchOptions.publicOrigin }, input) as Promise<
          { workspace: WorkspaceDto & { role: string }; accepted: boolean }
        >,
    },

    async asUser(name, asOptions) {
      const { userId, email } = await ensureUser(name);
      const session = await pool.query<{ id: string }>(
        `INSERT INTO team_sessions (user_id, issuer, sid, client_id)
         VALUES ($1, $2, $3, 'promptbranch-web')
         RETURNING id`,
        [userId, DEV_ISSUER, randomUUID()],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("harness: session insert returned no id");
      if (asOptions?.workspaceId) {
        await pool.query(
          `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [asOptions.workspaceId, userId, asOptions.role ?? "contributor", randomUUID()],
        );
      }
      return {
        userId,
        sessionId,
        email,
        principal: {
          kind: "human",
          userId,
          sessionId,
          authenticatedAt: new Date().toISOString(),
        },
      };
    },

    async asAgent(name, ownerUserId, agentOptions) {
      const scopes = agentOptions?.scopes ?? ["catalog:read"];
      const generationRow = await pool.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [agentOptions?.workspaceId, ownerUserId],
      );
      const membershipGeneration = generationRow.rows[0]?.generation ?? randomUUID();
      const token = await pool.query<{ id: string }>(
        `INSERT INTO team_agent_tokens (workspace_id, owner_user_id, name, secret_hash, scopes, membership_generation, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days')
         RETURNING id`,
        [
          agentOptions?.workspaceId,
          ownerUserId,
          name,
          sha256Hex(randomUUID()),
          scopes,
          membershipGeneration,
        ],
      );
      const tokenId = token.rows[0]?.id;
      if (!tokenId) throw new Error("harness: agent token insert returned no id");
      return {
        tokenId,
        ownerUserId,
        scopes,
        principal: { kind: "agent", userId: ownerUserId, tokenId, scopes },
      };
    },

    async createWorkspace(name, ownerUserId) {
      const serverEpoch = randomUUID();
      const generation = randomUUID();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO team_workspaces (name, server_epoch) VALUES ($1, $2) RETURNING id`,
        [name, serverEpoch],
      );
      const workspaceId = inserted.rows[0]?.id;
      if (!workspaceId) throw new Error("harness: workspace insert returned no id");
      await pool.query(
        `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
         VALUES ($1, $2, 'owner', $3)`,
        [workspaceId, ownerUserId, generation],
      );
      return { workspaceId, generation, serverEpoch };
    },

    async seedPrompt(workspaceId, promptOptions) {
      const title = promptOptions?.title ?? "Seed prompt";
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO team_prompts (workspace_id, title, description)
         VALUES ($1, $2, $3) RETURNING id`,
        [workspaceId, title, promptOptions?.description ?? ""],
      );
      const promptId = inserted.rows[0]?.id;
      if (!promptId) throw new Error("harness: prompt insert returned no id");
      return { promptId, title };
    },

    async seedRevision(workspaceId, promptId, revisionOptions) {
      if (!revisionOptions?.authorUserId) {
        throw new Error("harness: seedRevision requires authorUserId (revisions have exactly one author)");
      }
      const content = revisionOptions?.content ?? "Seed prompt content.\n";
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO team_revisions
           (workspace_id, prompt_id, parent_revision_id, content, content_hash, change_note, author_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          workspaceId,
          promptId,
          revisionOptions?.parentRevisionId ?? null,
          content,
          sha256Hex(content),
          revisionOptions?.changeNote ?? "seed",
          revisionOptions?.authorUserId ?? null,
        ],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new Error("harness: revision insert returned no id");
      return { revisionId, contentHash: sha256Hex(content) };
    },

    async publishRevision(workspaceId, promptId, revisionId) {
      await pool.query(
        `INSERT INTO team_publications (workspace_id, revision_id, prompt_id, source)
         VALUES ($1, $2, $3, 'seed')`,
        [workspaceId, revisionId, promptId],
      );
      await pool.query(
        `UPDATE team_prompts
         SET approved_revision_id = $3, entity_version = entity_version + 1
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, promptId, revisionId],
      );
    },

    async insertCrossWorkspaceCandidate() {
      const owner = await ensureUser("FK Owner");
      const alpha = await harness.createWorkspace("FK Alpha", owner.userId);
      const beta = await harness.createWorkspace("FK Beta", owner.userId);
      const alphaPrompt = await harness.seedPrompt(alpha.workspaceId, { title: "Alpha prompt" });
      const alphaRevision = await harness.seedRevision(alpha.workspaceId, alphaPrompt.promptId, {
        authorUserId: owner.userId,
        content: "alpha content",
      });
      const betaPrompt = await harness.seedPrompt(beta.workspaceId, { title: "Beta prompt" });
      // Valid ID from another workspace: the composite FK must reject it.
      return pool.query(
        `INSERT INTO team_proposals (workspace_id, prompt_id, base_revision_id, candidate_revision_id, author_user_id, rationale)
         VALUES ($1, $2, $3, $3, $4, 'cross-workspace candidate must be rejected')`,
        [beta.workspaceId, betaPrompt.promptId, alphaRevision.revisionId, owner.userId],
      ) as Promise<never>;
    },

    async count(table) {
      if (!COUNTABLE_TABLES.has(table)) throw new Error(`harness: table ${table} is not countable`);
      const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      const row = result.rows[0];
      if (!row) throw new Error(`harness: count(${table}) returned no row`);
      return Number(row.n);
    },

    emailFor(name) {
      return `synthetic-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}@promptbranch.test`;
    },

    async migrate(migrateOptions) {
      // Explicit dir wins; otherwise upgrade to the packaged full chain (the
      // initial subset filter applies only at harness creation).
      return runTeamMigrations({
        connectionString: withCredsAndDatabase(adminUrl, migrationUser, migrationPassword, databaseName),
        dir: migrateOptions?.dir ?? packagedMigrationsDir(),
        appRole,
      });
    },

    async withMigrationClient(fn) {
      const client = new pg.Client(
        withCredsAndDatabase(adminUrl, migrationUser, migrationPassword, databaseName),
      );
      await client.connect();
      try {
        await fn(client);
      } finally {
        await client.end();
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await raw.end().catch(() => undefined);
      await pool.end().catch(() => undefined);
      // Sockets pg already removed from the pool can still be mid-close;
      // let them finish before the FORCE drop, or the terminations surface
      // as unhandled errors under parallel suite load.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
      if (migrationTempDir) {
        await rm(migrationTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };

  return harness;
}
