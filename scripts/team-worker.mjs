#!/usr/bin/env node
// Team job worker entrypoint (root `pnpm team:worker`). Loops
// runDueJobs with a poll interval. SMTP must point at the local capture
// container in development; production runs the same loop as a service.

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

const databaseUrl = process.env.TEAM_DATABASE_URL;
const encryptionKey = process.env.TEAM_SESSION_ENCRYPTION_KEY;
const smtpUrl = process.env.TEAM_SMTP_URL;
const emailFrom = process.env.TEAM_EMAIL_FROM;

if (!databaseUrl || !encryptionKey || !smtpUrl || !emailFrom) {
  console.error("team:worker: requires TEAM_DATABASE_URL, TEAM_SESSION_ENCRYPTION_KEY, TEAM_SMTP_URL and TEAM_EMAIL_FROM.");
  process.exit(1);
}

const parsed = new URL(smtpUrl);
const smtpHost = parsed.hostname;
const smtpLoopback = ["127.0.0.1", "localhost", "::1"].includes(smtpHost);
if (!smtpLoopback && process.env.TEAM_ALLOW_REMOTE_SMTP !== "1") {
  console.error(`team:worker: refusing non-loopback SMTP host "${smtpHost}" (TEAM_ALLOW_REMOTE_SMTP=1 to override).`);
  process.exit(1);
}

// Imports the narrow jobs modules directly (not dist/index.js): the full
// index re-exports the share-scanner, whose package exports point at
// TypeScript source Node cannot execute. The jobs graph has no
// @promptbranch/share import. Requires
// `pnpm --filter @promptbranch/team-server build` to have run.
const dist = (module) => `file://${join(repoRoot, "packages", "team-server", "dist", module)}`;
const { runDueJobs } = await import(dist("jobs/worker.js"));
const { SecretBox } = await import(dist("auth/crypto.js"));
const { createTeamPool } = await import(dist("db.js"));

const pool = createTeamPool(databaseUrl, { applicationName: "promptbranch-team-worker", max: 2 });
const secretBox = SecretBox.fromBase64(encryptionKey);
const POLL_MS = Number(process.env.TEAM_WORKER_POLL_MS ?? 5000);

console.log(`team:worker: polling every ${POLL_MS}ms (SMTP ${smtpLoopback ? "local capture" : "remote (explicitly allowed)"})`);
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

while (running) {
  try {
    const result = await runDueJobs({ pool, secretBox, smtpUrl, emailFrom });
    if (result.claimed > 0) {
      console.log(`team:worker: claimed ${result.claimed}, delivered ${result.done}, failed ${result.failed}`);
    }
  } catch (error) {
    console.error(`team:worker: tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
await pool.end();
console.log("team:worker: stopped");
