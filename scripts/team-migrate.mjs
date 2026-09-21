#!/usr/bin/env node
// Forward-only migration runner entrypoint (root `pnpm team:migrate`).
// Runs as the DDL role (team_migrate) against TEAM_MIGRATION_DATABASE_URL, or
// TEAM_DATABASE_URL when the migration URL is not split out. Never prints
// connection strings (they carry credentials).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distMigrations = join(repoRoot, "packages", "team-server", "dist", "migrations.js");

// deploy/team/.env supplies local-stack defaults; real environment wins.
function loadLocalEnv() {
  const envPath = join(repoRoot, "deploy", "team", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadLocalEnv();

if (!existsSync(distMigrations)) {
  console.error("team:migrate: packages/team-server/dist/migrations.js is missing.");
  console.error("  Build first: pnpm --filter @promptbranch/team-server build");
  process.exit(1);
}

const connectionString =
  process.env.TEAM_MIGRATION_DATABASE_URL ?? process.env.TEAM_DATABASE_URL;

if (!connectionString) {
  console.error("team:migrate: set TEAM_MIGRATION_DATABASE_URL (DDL role) or TEAM_DATABASE_URL.");
  process.exit(1);
}

const parsed = new URL(connectionString);
if (!["127.0.0.1", "::1", "localhost"].includes(parsed.hostname) && process.env.TEAM_ALLOW_REMOTE_MIGRATE !== "1") {
  console.error(`team:migrate: refusing non-loopback database host "${parsed.hostname}".`);
  console.error("  Migrations against remote hosts require TEAM_ALLOW_REMOTE_MIGRATE=1.");
  process.exit(1);
}

const { runTeamMigrations } = await import(`file://${distMigrations}`);

try {
  const result = await runTeamMigrations({
    connectionString,
    appRole: process.env.TEAM_DB_APP_ROLE ?? "team_app",
  });
  console.log(`team:migrate: already applied: ${result.alreadyApplied.join(", ") || "(none)"}`);
  console.log(`team:migrate: applied: ${result.applied.join(", ") || "(none)"}`);
  if (result.appRolePresent === false) {
    console.log(`team:migrate: skipped DML grants — role "${result.appRole}" not present on this instance`);
  }
} catch (error) {
  console.error("team:migrate: FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
