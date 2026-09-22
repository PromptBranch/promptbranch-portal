#!/usr/bin/env node
// Encrypted PostgreSQL backup for the team workspaces database (plan P9).
// Nightly via cron/systemd timer, plus one run before every migration.
// 30-day retention; the SQLite snapshot store is backed up alongside when
// a path is given (portal.db lives on its own volume — never copy live
// database files blindly; use the documented online-backup statement).
//
// Usage:
//   TEAM_BACKUP_KEY_FILE=/secure/team-backup.key \
//   node scripts/team-backup.mjs --out /var/backups/promptbranch-team [--sqlite /data/portal.db]
//
// The key file holds exactly 32 raw bytes (head -c32 /dev/urandom > key).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  const envPath = join(repoRoot, "deploy", "team", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadLocalEnv();

const args = process.argv.slice(2);
const outDir = args.find((a) => a.startsWith("--out="))?.slice(6) ?? args[args.indexOf("--out") + 1];
const sqlitePath = args.find((a) => a.startsWith("--sqlite="))?.slice(9) ?? args[args.indexOf("--sqlite") + 1];
const keyFile = process.env.TEAM_BACKUP_KEY_FILE;
const databaseUrl = process.env.TEAM_DATABASE_URL;

if (!outDir || !keyFile || !databaseUrl) {
  console.error("team:backup: requires --out=<dir>, TEAM_BACKUP_KEY_FILE and TEAM_DATABASE_URL.");
  process.exit(1);
}
if (!existsSync(keyFile) || statSync(keyFile).size !== 32) {
  console.error("team:backup: TEAM_BACKUP_KEY_FILE must exist and hold exactly 32 raw bytes.");
  process.exit(1);
}

const parsed = new URL(databaseUrl);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = join(outDir, `team-${timestamp}`);

// pg_dump --format=custom streams a consistent snapshot without locking
// writes; openssl encrypts the stream so plaintext never touches disk.
const dump = spawnSync(
  "sh",
  ["-c", `pg_dump --format=custom --dbname="$PGURL" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$KEYFILE" > "$OUT"`],
  {
    env: { ...process.env, PGURL: databaseUrl, KEYFILE: keyFile, OUT: `${base}.dump.enc` },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
if (dump.status !== 0) {
  console.error("team:backup: pg_dump/openssl pipeline failed.");
  process.exit(1);
}
const sha256 = execFileSync("shasum", ["-a", "256", `${base}.dump.enc`]).toString().split(" ")[0];
writeFileSync(`${base}.sha256`, `${sha256}  ${base}.dump.enc\n`);
console.log(`team:backup: wrote ${base}.dump.enc (sha256 ${sha256.slice(0, 16)}…)`);

if (sqlitePath) {
  if (!existsSync(sqlitePath)) {
    console.warn(`team:backup: --sqlite path ${sqlitePath} missing; skipped.`);
  } else {
    execFileSync("sqlite3", [sqlitePath, `.backup '${base}-portal.db'`]);
    console.log(`team:backup: sqlite snapshot ${base}-portal.db`);
  }
}

// 30-day retention on this host's backup directory.
const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
for (const entry of readdirSync(outDir)) {
  const fullPath = join(outDir, entry);
  if (!/^team-/.test(entry) || !statSync(fullPath).isFile()) continue;
  if (statSync(fullPath).mtimeMs < cutoff) {
    unlinkSync(fullPath);
    console.log(`team:backup: pruned ${entry} (older than 30 days)`);
  }
}
