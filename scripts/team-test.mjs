#!/usr/bin/env node
// Prerequisite check + launcher for the @promptbranch/team-server test suites
// (root `pnpm test:team`). PG tests must fail clearly when prerequisites are
// absent — never silently skipped.

import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl =
  process.env.TEAM_TEST_DATABASE_URL ??
  "postgresql://team_admin:team_admin_dev_pw@127.0.0.1:54329/postgres";

const dbUrl = new URL(databaseUrl);
const host = dbUrl.hostname;
const port = Number(dbUrl.port || 5432);

const reachable = await new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (ok) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(2000);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
});

if (!reachable) {
  console.error(`test:team: PostgreSQL for team tests is not reachable at ${host}:${port}.`);
  console.error("  Run `pnpm team:dev:up` first (see deploy/team/README.md), or point");
  console.error("  TEAM_TEST_DATABASE_URL at a reachable PostgreSQL 16+ instance.");
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  ["--filter", "@promptbranch/team-server", "test"],
  { stdio: "inherit", cwd: repoRoot, env: { ...process.env, TEAM_TEST_DATABASE_URL: databaseUrl } },
);
process.exit(result.status ?? 1);
