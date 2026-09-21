#!/usr/bin/env node
// Post-start Keycloak bootstrap for the local development realm
// (`pnpm team:keycloak:init`, chained automatically by `pnpm team:dev:up`).
//
// Why the realm is built through the admin API instead of `--import-realm`
// (both verified against Keycloak 26.7.x):
//   1. Imported realms register the standard client-scope NAMES but never
//      materialize the scopes — later creation attempts 409 against the
//      registration and tokens would silently miss `auth_time`/`email_verified`
//      (contract C5 requires both). Realms created through the admin API get
//      the standard scopes fully materialized.
//   2. Import-time validation rejects the loopback wildcard-port redirect URI
//      (`http://127.0.0.1:*`) required for the desktop client's ephemeral
//      RFC 8252 callback; the admin API accepts it.
//   3. The confidential web client secret is set from deploy/team/.env so the
//      env file stays the single source of truth.
//
// The realm is fully synthetic: this script deletes and rebuilds it from
// deploy/team/realm.dev.json on every run, so `pnpm team:dev:up` always
// converges to a deterministic reference state. It talks to the
// container-internal admin endpoint only; the advertised token issuer stays
// pinned by KC_HOSTNAME (http://127.0.0.1:48080/realms/promptbranch-dev).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, "deploy", "team", ".env");
const realmJsonPath = join(repoRoot, "deploy", "team", "realm.dev.json");

function loadEnv() {
  const env = { ...process.env };
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

const env = loadEnv();
const base = process.env.TEAM_KEYCLOAK_ADMIN_URL ?? "http://127.0.0.1:48080";
const realm = env.TEAM_KEYCLOAK_REALM ?? "promptbranch-dev";
const adminUser = env.KC_BOOTSTRAP_ADMIN_USERNAME;
const adminPassword = env.KC_BOOTSTRAP_ADMIN_PASSWORD;
const webClientSecret = env.WEB_CLIENT_SECRET;

if (!adminUser || !adminPassword) {
  console.error("team:keycloak:init: KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD missing (deploy/team/.env)");
  process.exit(1);
}

const STD_SCOPES = ["basic", "profile", "email"];

function fail(message) {
  console.error(`team:keycloak:init: ${message}`);
  process.exit(1);
}

async function waitUntilReady(timeoutMs = 120_000) {
  // Master realm always exists on a started server (the target realm is
  // created by this script afterwards).
  const probe = `${base}/realms/master/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probe);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`Keycloak did not become ready at ${base} — run \`pnpm team:dev:up\` first`);
}

async function adminToken() {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: adminUser,
      password: adminPassword,
    }),
  });
  if (!res.ok) fail(`admin login failed (${res.status}) — check KC_BOOTSTRAP_ADMIN_* in deploy/team/.env`);
  return (await res.json()).access_token;
}

const token = await adminToken();

async function admin(path, options = {}) {
  const res = await fetch(`${base}/admin${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  return res;
}

async function adminJson(path, options) {
  const res = await admin(path, options);
  if (!res.ok) fail(`admin API ${options?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- run
await waitUntilReady();

const realmRepresentation = JSON.parse(readFileSync(realmJsonPath, "utf8"));
realmRepresentation.realm = realm;

// A non-empty clientScopes array in the realm payload suppresses the standard
// default-scope materialization (verified on 26.7.x), so custom scopes are
// created separately after the realm exists.
const customClientScopes = realmRepresentation.clientScopes ?? [];
delete realmRepresentation.clientScopes;

// Rebuild deterministically: the dev realm is a fixture, so stale local state
// is always discarded.
if ((await admin(`/realms/${realm}`)).ok) {
  const del = await admin(`/realms/${realm}`, { method: "DELETE" });
  if (!del.ok) fail(`could not delete existing realm "${realm}": ${del.status}`);
  console.log(`team:keycloak:init: removed stale realm "${realm}"`);
}

// The admin-API creation path (without a clientScopes payload) materializes
// the standard client scopes; realm import never does (see header note).
const created = await admin("/realms", {
  method: "POST",
  body: JSON.stringify(realmRepresentation),
});
if (!created.ok && created.status !== 409) {
  fail(`realm creation failed (${created.status}): ${await created.text()}`);
}

for (const scope of customClientScopes) {
  const { id: _drop, ...payload } = scope;
  const res = await admin(`/realms/${realm}/client-scopes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 409) fail(`client scope "${scope.name}" creation failed: ${res.status}`);
}

const scopeNames = new Set((await adminJson(`/realms/${realm}/client-scopes`)).map((s) => s.name));
for (const name of [...STD_SCOPES, "promptbranch-team-api"]) {
  if (!scopeNames.has(name)) fail(`client scope "${name}" missing after realm creation`);
}

// Desktop client: loopback wildcard-port redirect (RFC 8252 ephemeral port),
// S256 PKCE. Import/creation validation rejects that URI inside a realm
// payload, so it is registered on its own here.
let clients = await adminJson(`/realms/${realm}/clients`);
function findClient(clientId) {
  return clients.find((c) => c.clientId === clientId);
}
if (!findClient("promptbranch-desktop")) {
  await adminJson(`/realms/${realm}/clients`, {
    method: "POST",
    body: JSON.stringify({
      clientId: "promptbranch-desktop",
      name: "PromptBranch Desktop",
      enabled: true,
      protocol: "openid-connect",
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      redirectUris: ["http://127.0.0.1:*"],
      attributes: { "pkce.code.challenge.method": "S256" },
    }),
  });
  clients = await adminJson(`/realms/${realm}/clients`);
  console.log('team:keycloak:init: created client "promptbranch-desktop" (loopback wildcard-port + S256 PKCE)');
}

// Web client secret from .env (single source of truth).
const web = findClient("promptbranch-web");
if (!web) fail("reference client \"promptbranch-web\" missing after realm creation");
const secret = await adminJson(`/realms/${realm}/clients/${web.id}/client-secret`);
if (secret.value !== webClientSecret) {
  await adminJson(`/realms/${realm}/clients/${web.id}`, {
    method: "PUT",
    body: JSON.stringify({ secret: webClientSecret }),
  });
  console.log('team:keycloak:init: set "promptbranch-web" client secret from WEB_CLIENT_SECRET');
}

// Every reference client must resolve protocol claims from the standard
// scopes plus the team-api audience (C5).
const scopes = await adminJson(`/realms/${realm}/client-scopes`);
const scopeIds = new Map(scopes.map((s) => [s.name, s.id]));
for (const clientId of ["promptbranch-web", "promptbranch-desktop", "promptbranch-cli"]) {
  const client = findClient(clientId);
  if (!client) fail(`reference client "${clientId}" missing after realm creation`);
  const assigned = new Set(
    (await adminJson(`/realms/${realm}/clients/${client.id}/default-client-scopes`)).map((s) => s.name),
  );
  for (const scopeName of [...STD_SCOPES, "promptbranch-team-api"]) {
    if (!assigned.has(scopeName)) {
      await adminJson(`/realms/${realm}/clients/${client.id}/default-client-scopes/${scopeIds.get(scopeName)}`, {
        method: "PUT",
      });
      console.log(`team:keycloak:init: added default scope "${scopeName}" to ${clientId}`);
    }
  }
}

console.log("team:keycloak:init: realm ready (deterministic reference state)");
