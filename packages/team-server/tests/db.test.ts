import { describe, it, expect, afterAll } from "vitest";
import { teamError, TEAM_ERROR_CODES, isRetryableSqlError } from "../src/errors.js";
import { parseTeamEnv } from "../src/config.js";
import { createTeamTestHarness, type TeamTestHarness } from "./helpers.js";

// ---------------------------------------------------------------------------
// Pure units: configuration parsing and the stable error taxonomy (contract C2).
// ---------------------------------------------------------------------------

describe("team server configuration", () => {
  it("parses a minimal valid environment with defaults", () => {
    const parsed = parseTeamEnv({ TEAM_DATABASE_URL: "postgresql://u:p@127.0.0.1:54329/team" });
    expect(parsed.databaseUrl).toBe("postgresql://u:p@127.0.0.1:54329/team");
    expect(parsed.migrationDatabaseUrl).toBeUndefined();
    expect(parsed.appDbRole).toBe("team_app");
    expect(parsed.poolMax).toBe(10);
  });

  it("prefers an explicit migration URL and app role override", () => {
    const parsed = parseTeamEnv({
      TEAM_DATABASE_URL: "postgresql://app@127.0.0.1/db",
      TEAM_MIGRATION_DATABASE_URL: "postgresql://migrate@127.0.0.1/db",
      TEAM_DB_APP_ROLE: "",
      TEAM_DB_POOL_MAX: "4",
    });
    expect(parsed.migrationDatabaseUrl).toBe("postgresql://migrate@127.0.0.1/db");
    expect(parsed.appDbRole).toBeNull(); // empty string explicitly disables granting
    expect(parsed.poolMax).toBe(4);
  });

  it("rejects missing or non-postgres URLs", () => {
    expect(() => parseTeamEnv({})).toThrow(/TEAM_DATABASE_URL/);
    expect(() => parseTeamEnv({ TEAM_DATABASE_URL: "mysql://x/y" })).toThrow(/postgresql/);
  });
});

describe("team error taxonomy", () => {
  it("maps every stable code to its contract HTTP status", () => {
    const expected: Array<[string, number]> = [
      ["UNAUTHENTICATED", 401],
      ["SESSION_REVOKED", 401],
      ["WORKSPACE_FORBIDDEN", 403],
      ["ROLE_FORBIDDEN", 403],
      ["SCOPE_FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["VALIDATION_FAILED", 422],
      ["SECRET_BLOCKED", 422],
      ["STALE_BASE", 409],
      ["STALE_ENTITY", 409],
      ["SELF_REVIEW", 409],
      ["LAST_OWNER", 409],
      ["COMMAND_ID_REUSED", 409],
      ["MEMBERSHIP_CHANGED", 409],
      ["CURSOR_EXPIRED", 410],
      ["SNAPSHOT_EXPIRED", 410],
      ["SERVER_EPOCH_CHANGED", 410],
      ["PROTOCOL_UNSUPPORTED", 426],
      ["RATE_LIMITED", 429],
      ["QUOTA_EXCEEDED", 429],
      ["UNAVAILABLE", 503],
      ["PAYLOAD_TOO_LARGE", 413],
    ];
    for (const [code, status] of expected) {
      expect(TEAM_ERROR_CODES).toContain(code);
      expect(teamError(code as never, "x").httpStatus).toBe(status);
    }
  });

  it("marks only transport-class errors retryable", () => {
    expect(teamError("RATE_LIMITED", "x").retryable).toBe(true);
    expect(teamError("UNAVAILABLE", "x").retryable).toBe(true);
    // 429 but never auto-retried until the user resolves capacity.
    expect(teamError("QUOTA_EXCEEDED", "x").retryable).toBe(false);
    expect(teamError("VALIDATION_FAILED", "x").retryable).toBe(false);
  });

  it("identifies serialization and deadlock SQL states as retryable", () => {
    expect(isRetryableSqlError({ code: "40001" })).toBe(true);
    expect(isRetryableSqlError({ code: "40P01" })).toBe(true);
    expect(isRetryableSqlError({ code: "23503" })).toBe(false);
    expect(isRetryableSqlError(new Error("nope"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL storage foundation. Each suite below runs against a real scratch
// database created by the harness; there is deliberately no SQLite fallback.
// ---------------------------------------------------------------------------

const harnesses: TeamTestHarness[] = [];

async function makeHarness(options?: Parameters<typeof createTeamTestHarness>[0]) {
  const harness = await createTeamTestHarness(options);
  harnesses.push(harness);
  return harness;
}

afterAll(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

describe("migration chain", () => {
  it("applies the fresh chain and is idempotent on re-run", async () => {
    const h = await makeHarness();
    expect(h.migrationResult.applied).toEqual([
      "001-team-foundation.sql",
      "002-team-content.sql",
      "003-team-sync-operations.sql",
    ]);
    expect(h.migrationResult.alreadyApplied).toEqual([]);

    const again = await h.migrate();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual([
      "001-team-foundation.sql",
      "002-team-content.sql",
      "003-team-sync-operations.sql",
    ]);

    const tables = await h.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'team_%'`,
    );
    expect(Number(tables.rows[0]?.n)).toBeGreaterThanOrEqual(24);
  });

  it("supports upgrading a database that only has the first migration", async () => {
    const h = await makeHarness({ includeMigrations: /^001-/ });
    expect(h.migrationResult.applied).toEqual(["001-team-foundation.sql"]);

    const upgrade = await h.migrate();
    expect(upgrade.applied).toEqual(["002-team-content.sql", "003-team-sync-operations.sql"]);
    expect(await h.count("team_prompts")).toBe(0);
  });

  it("serializes concurrent runners through the advisory lock", async () => {
    const h = await makeHarness({ includeMigrations: /^001-/ });
    const [a, b] = await Promise.all([h.migrate(), h.migrate()]);
    // Both runners succeed; each migration file lands exactly once.
    const applied = [...a.applied, ...b.applied];
    expect(applied).toEqual(["002-team-content.sql", "003-team-sync-operations.sql"]);
    expect(await h.count("team_schema_migrations")).toBe(3);
  });

  it("refuses to run when an applied migration's checksum changed", async () => {
    const h = await makeHarness();
    await h.withMigrationClient((client) =>
      client.query(
        "UPDATE team_schema_migrations SET checksum = 'deadbeef' WHERE name = '001-team-foundation.sql'",
      ),
    );
    await expect(h.migrate()).rejects.toThrow(/changed after it was applied/);
  });

  it("grants the app role DML but never DDL", async () => {
    const h = await makeHarness();
    // DML works through the app-role pool.
    await h.pool.query(
      `INSERT INTO team_users (issuer, subject, verified_email, normalized_email, display_name)
       VALUES ('http://127.0.0.1:48080/realms/promptbranch-dev', 'grants-check', 'grants-check@promptbranch.test', 'grants-check@promptbranch.test', 'Grants Check')`,
    );
    expect(await h.count("team_users")).toBe(1);
    // DDL is refused: migrations are the only writers of schema.
    await expect(h.pool.query("CREATE TABLE team_must_not_exist (id int)")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("cross-workspace isolation", () => {
  it("rejects a valid foreign-workspace revision as a proposal candidate", async () => {
    const h = await makeHarness();
    await expect(h.insertCrossWorkspaceCandidate()).rejects.toMatchObject({ code: "23503" });
    expect(await h.count("team_proposals")).toBe(0);
  });

  it("rejects a parent revision from a different prompt of the same workspace", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Parent Check");
    const w = await h.createWorkspace("Parent Workspace", owner.userId);
    const promptA = await h.seedPrompt(w.workspaceId, { title: "Prompt A" });
    const promptB = await h.seedPrompt(w.workspaceId, { title: "Prompt B" });
    const revA = await h.seedRevision(w.workspaceId, promptA.promptId, { authorUserId: owner.userId });

    await expect(
      h.pool.query(
        `INSERT INTO team_revisions (workspace_id, prompt_id, parent_revision_id, content, content_hash, author_user_id)
         VALUES ($1, $2, $3, 'orphan content', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', $4)`,
        [w.workspaceId, promptB.promptId, revA.revisionId, owner.userId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await h.count("team_revisions")).toBe(1);
  });
});

describe("immutable revisions", () => {
  it("rejects UPDATE of content, hash, parent or author", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Immutability");
    const other = await h.asUser("Immutability Other");
    const w = await h.createWorkspace("Immutability Workspace", owner.userId);
    const prompt = await h.seedPrompt(w.workspaceId, { title: "Immutable prompt" });
    const rev = await h.seedRevision(w.workspaceId, prompt.promptId, {
      authorUserId: owner.userId,
      content: "approved content",
    });

    await expect(
      h.pool.query("UPDATE team_revisions SET content = 'tampered' WHERE id = $1", [rev.revisionId]),
    ).rejects.toMatchObject({ code: "PBT01" });
    await expect(
      h.pool.query(
        "UPDATE team_revisions SET content_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id = $1",
        [rev.revisionId],
      ),
    ).rejects.toMatchObject({ code: "PBT01" });
    // Re-assigning the same author is a no-op, so use a genuinely different one.
    await expect(
      h.pool.query(
        "UPDATE team_revisions SET author_user_id = $2 WHERE id = $1",
        [rev.revisionId, other.userId],
      ),
    ).rejects.toMatchObject({ code: "PBT01" });
    expect(await h.count("team_revisions")).toBe(1);
  });

  it("allows controlled DELETE for lifecycle purge", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Purge");
    const w = await h.createWorkspace("Purge Workspace", owner.userId);
    const prompt = await h.seedPrompt(w.workspaceId, { title: "Purge prompt" });
    const rev = await h.seedRevision(w.workspaceId, prompt.promptId, { authorUserId: owner.userId });
    await h.pool.query("DELETE FROM team_revisions WHERE id = $1", [rev.revisionId]);
    expect(await h.count("team_revisions")).toBe(0);
  });
});

describe("workspace transactions", () => {
  it("locks the workspace row first and rolls back on failure", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Tx Owner");
    const w = await h.createWorkspace("Tx Workspace", owner.userId);

    await expect(
      h.service.withWorkspaceTransaction({ workspaceId: w.workspaceId }, async ({ tx }) => {
        // The workspace row is already locked: a competing lock from the raw
        // connection cannot be acquired (proves lock-before-work ordering).
        await expect(
          h.raw.query("SELECT id FROM team_workspaces WHERE id = $1 FOR UPDATE NOWAIT", [w.workspaceId]),
        ).rejects.toMatchObject({ code: "55P03" });
        await tx.query(
          `INSERT INTO team_tags (workspace_id, name, normalized_name) VALUES ($1, 'rollback', 'rollback')`,
          [w.workspaceId],
        );
        throw teamError("VALIDATION_FAILED", "deliberate failure");
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(await h.count("team_tags")).toBe(0);
  });

  it("treats unknown workspaces as NOT_FOUND", async () => {
    const h = await makeHarness();
    await expect(
      h.service.withWorkspaceTransaction(
        { workspaceId: "00000000-0000-4000-8000-000000000000" },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("re-runs serialization conflicts with the same command identity, max 3 attempts", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Retry Owner");
    const w = await h.createWorkspace("Retry Workspace", owner.userId);

    let attempts = 0;
    const result = await h.service.withWorkspaceTransaction(
      { workspaceId: w.workspaceId, commandId: "same-command-id" },
      async ({ tx }) => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("serialization failure"), { code: "40001" });
        }
        await tx.query(
          `INSERT INTO team_tags (workspace_id, name, normalized_name) VALUES ($1, 'committed', 'committed')`,
          [w.workspaceId],
        );
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(attempts).toBe(3);
    // The retried attempts committed nothing; exactly one mutation survives.
    expect(await h.count("team_tags")).toBe(1);

    let alwaysAttempts = 0;
    await expect(
      h.service.withWorkspaceTransaction({ workspaceId: w.workspaceId, commandId: "same-command-id" }, async () => {
        alwaysAttempts += 1;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", details: { attempts: 3 } });
    expect(alwaysAttempts).toBe(3);
  });
});

describe("connection lifecycle", () => {
  it("releases every connection when the harness closes", async () => {
    // A prior harness (still open) lends its admin pool for the post-close check.
    const observer = harnesses[0];
    const h = await makeHarness();
    const databaseName = h.databaseName;
    await h.close();

    const leftover = await observer!.adminPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    );
    expect(Number(leftover.rows[0]?.n)).toBe(0);
    // Remove from the cleanup list: already closed.
    const index = harnesses.findIndex((entry) => entry.databaseName === databaseName);
    if (index !== -1) harnesses.splice(index, 1);
  });
});

describe("append-only stores", () => {
  it("rejects UPDATE of audit rows while DELETE stays reserved for retention purge", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Auditor");
    const w = await h.createWorkspace("Audit Workspace", owner.userId);
    const inserted = await h.pool.query<{ id: string }>(
      `INSERT INTO team_audit (workspace_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'workspace.create', 'workspace', $3) RETURNING id`,
      [w.workspaceId, owner.userId, w.workspaceId],
    );
    const auditId = inserted.rows[0]?.id;
    expect(auditId).toBeTypeOf("string");

    await expect(
      h.pool.query("UPDATE team_audit SET action = 'tampered' WHERE id = $1", [auditId]),
    ).rejects.toMatchObject({ code: "PBT03" });
    // Retention purge deletes; it does not rewrite.
    await h.pool.query("DELETE FROM team_audit WHERE id = $1", [auditId]);
    expect(await h.count("team_audit")).toBe(0);
  });

  it("rejects UPDATE and DELETE of comments (append-only)", async () => {
    const h = await makeHarness();
    const owner = await h.asUser("Commenter");
    const w = await h.createWorkspace("Comment Workspace", owner.userId);
    const prompt = await h.seedPrompt(w.workspaceId, { title: "Comment prompt" });
    const revision = await h.seedRevision(w.workspaceId, prompt.promptId, { authorUserId: owner.userId });
    const proposal = await h.pool.query<{ id: string }>(
      `INSERT INTO team_proposals (workspace_id, prompt_id, base_revision_id, candidate_revision_id, author_user_id, rationale)
       VALUES ($1, $2, $3, $3, $4, 'needs discussion') RETURNING id`,
      [w.workspaceId, prompt.promptId, revision.revisionId, owner.userId],
    );
    const proposalId = proposal.rows[0]?.id;
    expect(proposalId).toBeTypeOf("string");

    const comment = await h.pool.query<{ id: string }>(
      `INSERT INTO team_comments (workspace_id, proposal_id, author_user_id, body)
       VALUES ($1, $2, $3, 'first comment') RETURNING id`,
      [w.workspaceId, proposalId, owner.userId],
    );
    const commentId = comment.rows[0]?.id;
    await expect(
      h.pool.query("UPDATE team_comments SET body = 'edited' WHERE id = $1", [commentId]),
    ).rejects.toMatchObject({ code: "PBT02" });
    await expect(
      h.pool.query("DELETE FROM team_comments WHERE id = $1", [commentId]),
    ).rejects.toMatchObject({ code: "PBT02" });
    expect(await h.count("team_comments")).toBe(1);
  });
});
