#!/usr/bin/env node
// P0 contract fixture verification entrypoint.
//
// Refuses to run against any non-loopback or non-synthetic configuration
// (contract C10), checks the local team stack, and reports the G0 contract
// acceptance status. Until the main PromptBranch repository supplies the D0
// `@promptbranch/team-contract` artifact (exact packed/published version),
// fixture verification cannot run: this script exits 2 with "G0 pending" so
// the missing prerequisite is loud, never silently skipped.
//
// Exit codes:
//   0  verification completed (artifact present and verified)
//   1  refused: non-loopback / non-synthetic configuration
//   2  G0 pending: contract artifact not installed (or fixtures not verifiable)
//   3  local team stack not reachable

import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DEFAULTS = {
  databaseUrl: "postgresql://team_admin:team_admin_dev_pw@127.0.0.1:54329/postgres",
  issuer: "http://127.0.0.1:48080/realms/promptbranch-dev",
  smtpUrl: "smtp://127.0.0.1:48025",
  publicOrigin: "http://127.0.0.1:4317",
  realm: "promptbranch-dev",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function urlHost(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(1, `${label} is not a valid URL: ${redact(raw)}`);
  }
  return parsed.hostname;
}

function assertLoopback(raw, label) {
  const host = urlHost(raw, label);
  if (!LOOPBACK_HOSTS.has(host)) {
    fail(1, `refusing non-loopback ${label} host "${host}" — team:fixtures only runs against the local synthetic stack`);
  }
}

function redact(raw) {
  return String(raw).replace(/:\/\/[^@/]+@/, "://<credentials>@");
}

function fail(code, message) {
  console.error(`team:fixtures: ${message}`);
  process.exit(code);
}

function checkTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const databaseUrl = process.env.TEAM_TEST_DATABASE_URL ?? DEFAULTS.databaseUrl;
const issuer = process.env.TEAM_OIDC_ISSUER ?? DEFAULTS.issuer;
const smtpUrl = process.env.TEAM_SMTP_URL ?? DEFAULTS.smtpUrl;
const publicOrigin = process.env.TEAM_PUBLIC_ORIGIN ?? DEFAULTS.publicOrigin;

assertLoopback(databaseUrl, "database URL");
assertLoopback(issuer, "OIDC issuer");
assertLoopback(smtpUrl, "SMTP URL");
assertLoopback(publicOrigin, "public origin");

const issuerUrl = new URL(issuer);
if (!issuer.startsWith("http://127.0.0.1:") && !issuer.startsWith("http://[::1]:") && !issuer.startsWith("http://localhost:")) {
  fail(1, "team:fixtures requires the loopback HTTP issuer of the synthetic development realm");
}
if (!issuerUrl.pathname.endsWith(`/${DEFAULTS.realm}`)) {
  fail(1, `refusing non-synthetic realm "${issuerUrl.pathname}" — expected the ${DEFAULTS.realm} development realm`);
}

const dbUrl = new URL(databaseUrl);
const smtp = new URL(smtpUrl);
const smtpPort = Number(smtp.port || (smtp.protocol === "smtps:" ? 465 : 25));

const stack = {
  postgres: await checkTcp(dbUrl.hostname, Number(dbUrl.port || 5432)),
  keycloak: await checkTcp(issuerUrl.hostname, Number(issuerUrl.port || 80)),
  smtp: await checkTcp(smtp.hostname, smtpPort),
};

for (const [name, up] of Object.entries(stack)) {
  console.log(`team:fixtures: ${name.padEnd(9)} ${up ? "reachable" : "NOT reachable"}`);
}
if (!stack.postgres || !stack.keycloak || !stack.smtp) {
  fail(3, "local team stack incomplete — run `pnpm team:dev:up` first (see deploy/team/README.md)");
}

let artifact;
try {
  artifact = require.resolve("@promptbranch/team-contract/package.json");
} catch {
  console.error("team:fixtures: G0 pending — @promptbranch/team-contract artifact is not installed.");
  console.error("  The main PromptBranch repository owns the contract package (Zod schemas,");
  console.error("  fixtures, mock). Install the exact packed/published D0 artifact, verify it");
  console.error("  against docs-internal/contracts/PB-TEAM-1.sha256, then re-run.");
  process.exit(2);
}

console.log(`team:fixtures: contract artifact found at ${artifact}`);
console.error("team:fixtures: fixture verification against real route outputs lands with the C4 team API (P2+); routes are not implemented yet.");
process.exit(2);
