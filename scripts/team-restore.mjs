#!/usr/bin/env node
// Backup-restore runbook driver (plan P9). Two steps, mirroring the
// recovery contract:
//
//   1) Restore the dump, then rotate the world so pre-restore credentials
//      cannot survive:
//        node scripts/team-restore.mjs --dump=/var/backups/team-x.dump.enc \
//             --key-file=/secure/team-backup.key \
//             --restored-from="team-x" [--note="incident 123"]
//      The portal must be running with TEAM_RECOVERY_MODE=1 BEFORE this
//      step: every team route 503s until the runbook completes.
//
//   2) After verifying the current roster, reconcile and close the window:
//        node scripts/team-restore.mjs --finish-recovery=/path/roster.json
//      roster.json: {"emails": ["owner@example.com", ...]}
//      Then clear TEAM_RECOVERY_MODE and restart the portal.
//
// A deliberately stale backup is safe by construction: epoch rotation kills
// cached clients, sessions/agent tokens are revoked, and any membership the
// roster does not confirm is removed (sole-owner workspaces are protected
// and reported for manual resolution instead).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const flag = (name) => {
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databaseUrl = process.env.TEAM_DATABASE_URL;
if (!databaseUrl) {
  console.error("team:restore: requires TEAM_DATABASE_URL.");
  process.exit(1);
}
const dist = (module) => `file://${join(repoRoot, "packages", "team-server", "dist", module)}`;

const dump = flag("dump");
const rosterPath = flag("finish-recovery");

if (!dump && !rosterPath) {
  console.error("team:restore: pass --dump=<file> (with --key-file=) or --finish-recovery=<roster.json>.");
  process.exit(1);
}

if (dump) {
  const keyFile = flag("key-file");
  const restoredFrom = flag("restored-from") ?? dump;
  const note = flag("note") ?? "";
  if (!keyFile || !existsSync(keyFile) || !existsSync(dump)) {
    console.error("team:restore: --dump and an existing --key-file are required.");
    process.exit(1);
  }
  if (process.env.TEAM_RECOVERY_MODE !== "1") {
    console.error("team:restore: refusing to restore while TEAM_RECOVERY_MODE is not 1 — bring the portal up in recovery first.");
    process.exit(1);
  }

  // Decrypt to a pipe (never a plaintext file) and restore.
  const restored = spawnSync(
    "sh",
    ["-c", `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$KEYFILE" -in "$DUMP" | pg_restore --clean --if-exists --dbname="$PGURL"`],
    { env: { ...process.env, KEYFILE: keyFile, DUMP: dump, PGURL: databaseUrl }, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (restored.status !== 0) {
    console.error("team:restore: pg_restore failed (the database is now in an UNKNOWN state — do not clear recovery mode).");
    process.exit(1);
  }

  const { enterRecovery } = await import(dist("domain/recovery.js"));
  const { createTeamPool } = await import(dist("db.js"));
  const pool = createTeamPool(databaseUrl, { applicationName: "team-restore", max: 1 });
  try {
    const window = await enterRecovery(pool, { restoredFrom, note });
    console.log(
      `team:restore: recovery window ${window.recoveryId} open — epochs rotated=${window.rotatedEpochs}, ` +
        `sessions revoked=${window.revokedAppSessions}, agent tokens revoked=${window.revokedAgentTokens}, jobs cancelled=${window.cancelledJobs}`,
    );
    console.log("team:restore: NEXT — verify the roster, then run with --finish-recovery=<roster.json>, then clear TEAM_RECOVERY_MODE and restart the portal.");
  } finally {
    await pool.end();
  }
} else {
  const rosterRaw = JSON.parse(readFileSync(rosterPath, "utf8"));
  const emails = Array.isArray(rosterRaw) ? rosterRaw : rosterRaw.emails;
  if (!Array.isArray(emails) || emails.length === 0) {
    console.error("team:restore: roster.json must be {" + '"emails": [...]}' + " or an email array.");
    process.exit(1);
  }

  const { finishRecoveryWithRoster } = await import(dist("domain/recovery.js"));
  const { createTeamPool } = await import(dist("db.js"));
  const pool = createTeamPool(databaseUrl, { applicationName: "team-restore", max: 1 });
  try {
    const result = await finishRecoveryWithRoster(pool, { rosterEmails: emails });
    console.log(
      `team:restore: recovery ${result.recoveryId} closed — kept=${result.keptMemberships}, removed=${result.removedMemberships}, ` +
        `sole-owner workspaces needing manual resolution=${result.lastOwnerProtections}`,
    );
    if (result.lastOwnerProtections > 0) {
      console.error("team:restore: resolve protected workspaces (add a rostered owner) and re-run --finish-recovery before leaving recovery mode.");
      process.exitCode = 2;
    } else {
      console.log("team:restore: clear TEAM_RECOVERY_MODE and restart the portal to resume ordinary traffic at the rotated epoch.");
    }
  } finally {
    await pool.end();
  }
}
