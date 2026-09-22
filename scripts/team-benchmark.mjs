#!/usr/bin/env node
// Pilot readiness benchmark (plan P10; contract nonfunctional targets).
// Seeds a synthetic workspace with 1,000 prompts / 10,000 published
// revisions, then drives a REAL HTTP server with 20 concurrent synthetic
// agent clients and measures:
//   - p50/p95 approved prompt read and search latency      (target ≤ 500 ms)
//   - p95 command (proposal.submit) acceptance             (target ≤ 1 s)
//   - full catalogue bootstrap duration                    (target ≤ 60 s)
//   - second-client feed visibility after a committed write (target ≤ 30 s)
// The runner REFUSES non-loopback origins and uses synthetic content only.
// Exit code 1 when a target is missed (launch-blocking per the contract).
//
// Prerequisites: the local stack (`pnpm team:dev:up`), a running portal
// (dev or production mode) on TEAM_BENCH_ORIGIN (default
// http://127.0.0.1:4317), and TEAM_DATABASE_URL pointing at the team DB.

import { createHash, randomUUID } from "node:crypto";
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

const ORIGIN = (process.env.TEAM_BENCH_ORIGIN ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const DATABASE_URL = process.env.TEAM_DATABASE_URL;
const CLIENTS = Number(process.env.TEAM_BENCH_CLIENTS ?? 20);
const READ_SAMPLES = Number(process.env.TEAM_BENCH_READS ?? 200);
const COMMAND_SAMPLES = Number(process.env.TEAM_BENCH_COMMANDS ?? 50);

const TARGETS = { readP95Ms: 500, searchP95Ms: 500, commandP95Ms: 1_000, bootstrapMs: 60_000, feedVisibilityMs: 30_000 };

const host = new URL(ORIGIN).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`team:benchmark: refusing non-loopback origin "${ORIGIN}" — benchmark only synthetic environments.`);
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("team:benchmark: requires TEAM_DATABASE_URL (the same database the target server uses).");
  process.exit(1);
}

// Raw SQL through the compiled team-server db module (same resolution the
// worker uses; requires `pnpm --filter @promptbranch/team-server build`).
const dist = (module) => `file://${join(repoRoot, "packages", "team-server", "dist", module)}`;
const { createTeamPool } = await import(dist("db.js"));

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function mintToken() {
  // Mirrors the runtime format: pbt_<uuid>.<43-char base64url secret>; only
  // the sha256 is stored. 32 random bytes → 43 base64url characters.
  const secret = Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), "hex").toString("base64url");
  return { token: `pbt_${randomUUID()}.${secret}`, hash: createHash("sha256").update(secret).digest() };
}

const pool = createTeamPool(DATABASE_URL, { applicationName: "team-benchmark", max: 2 });
const client = await pool.connect();

// Idempotent re-runs: purge any leftover synthetic workspace and bench
// identities from a previously aborted run (same child-first order the
// product's purge sweep uses).
const PURGE_TABLES = [
  "team_comments", "team_reviews", "team_proposals", "team_publications", "team_prompt_search",
  "team_activity_items", "team_prompt_tags", "team_collection_prompts", "team_revisions",
  "team_prompts", "team_tags", "team_collections", "team_bootstraps", "team_changes",
  "team_command_receipts", "team_jobs", "team_invitations", "team_agent_tokens", "team_memberships",
];
for (const workspace of (await client.query("SELECT id FROM team_workspaces WHERE name = 'Benchmark Synthetic'")).rows) {
  await client.query("UPDATE team_prompts SET approved_revision_id = NULL WHERE workspace_id = $1", [workspace.id]);
  for (const table of PURGE_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspace.id]);
  }
  await client.query("DELETE FROM team_audit WHERE workspace_id = $1", [workspace.id]);
  await client.query("DELETE FROM team_workspaces WHERE id = $1", [workspace.id]);
}
await client.query("DELETE FROM team_users WHERE issuer = 'http://bench.invalid'");

console.log(`team:benchmark: seeding synthetic workspace against ${ORIGIN}…`);
const workspaceId = randomUUID();
const ownerUserId = randomUUID();
const epoch = randomUUID();
const clients = [];
await client.query("BEGIN");
try {
  await client.query(
    `INSERT INTO team_workspaces (id, name, server_epoch) VALUES ($1, 'Benchmark Synthetic', $2)`,
    [workspaceId, epoch],
  );
  await client.query(
    `INSERT INTO team_users (id, issuer, subject, verified_email, normalized_email, display_name)
     VALUES ($1, 'http://bench.invalid', 'bench-owner', 'bench-owner@synthetic.invalid', 'bench-owner@synthetic.invalid', 'Bench Owner')`,
    [ownerUserId],
  );
  await client.query(
    `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'maintainer', $3)`,
    [workspaceId, ownerUserId, randomUUID()],
  );

  // 1,000 prompts × 10 revisions, all published, head = newest revision.
  // Synthetic content only; a recognizable marker guards accidental reuse.
  for (let batch = 0; batch < 10; batch++) {
    const promptRows = [];
    const revisionRows = [];
    for (let i = 0; i < 100; i++) {
      const n = batch * 100 + i;
      const promptId = randomUUID();
      promptRows.push([promptId, `Synthetic benchmark prompt ${n}`]);
      let parent = null;
      for (let r = 0; r < 10; r++) {
        const revisionId = randomUUID();
        const content = `synthetic-bench-canary prompt ${n} revision ${r}\n${"lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(40)}`;
        revisionRows.push([
          revisionId,
          promptId,
          parent,
          content,
          createHash("sha256").update(content).digest("hex"),
          `bench r${r}`,
          ownerUserId,
        ]);
        parent = revisionId;
      }
      // Point the head at the last revision of this prompt (filled below).
      promptRows[promptRows.length - 1].push(parent);
    }
    for (const [id, title, head] of promptRows) {
      await client.query(
        `INSERT INTO team_prompts (workspace_id, id, title, approved_revision_id) VALUES ($1, $2, $3, $4)`,
        [workspaceId, id, title, head],
      );
    }
    for (const [id, promptId, parent, content, hash, note, author] of revisionRows) {
      await client.query(
        `INSERT INTO team_revisions (workspace_id, id, prompt_id, parent_revision_id, content, content_hash, change_note, author_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [workspaceId, id, promptId, parent, content, hash, note, author],
      );
      await client.query(
        `INSERT INTO team_publications (workspace_id, revision_id, prompt_id, source) VALUES ($1, $2, $3, 'seed')`,
        [workspaceId, id, promptId],
      );
    }
  }

  // 20 synthetic agent clients (contributor-level owner via 20 members).
  for (let i = 0; i < CLIENTS; i++) {
    const userId = randomUUID();
    await client.query(
      `INSERT INTO team_users (id, issuer, subject, verified_email, normalized_email, display_name)
       VALUES ($1, 'http://bench.invalid', $2, $3, $3, $4)`,
      [userId, `bench-client-${i}`, `bench-client-${i}@synthetic.invalid`, `Bench Client ${i}`],
    );
    const generation = randomUUID();
    await client.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'contributor', $3)`,
      [workspaceId, userId, generation],
    );
    const { token, hash } = mintToken();
    await client.query(
      `INSERT INTO team_agent_tokens (workspace_id, id, owner_user_id, name, secret_hash, scopes, membership_generation, expires_at)
       VALUES ($1, $2, $3, $4, $5, ARRAY['catalog:read','proposal:write']::text[], $6, now() + interval '2 hours')`,
      [workspaceId, token.split(".")[0].replace("pbt_", ""), userId, `bench client ${i}`, hash, generation],
    );
    clients.push({ token, generation, userId });
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  console.error(`team:benchmark: seed failed: ${error instanceof Error ? error.message : String(error)}`);
  client.release();
  await pool.end();
  process.exit(1);
}

const prompts = (await client.query("SELECT p.id AS prompt_id, p.approved_revision_id FROM team_prompts p WHERE p.workspace_id = $1", [workspaceId])).rows;
console.log(`team:benchmark: seeded ${prompts.length} prompts / 10,000 revisions, ${clients.length} agent clients`);

const HEADERS = { "x-promptbranch-team-protocol": "1" };
const api = async (path, init = {}) => {
  const started = performance.now();
  const response = await fetch(`${ORIGIN}/api/team/v1${path}`, init);
  return { status: response.status, ms: performance.now() - started, response };
};
const authed = (clientPrincipal, extra = {}) => ({
  ...extra,
  headers: { ...HEADERS, authorization: `Bearer ${clientPrincipal.token}` },
});

async function sampleConcurrent(total, fn) {
  const samples = [];
  let issued = 0;
  const worker = async (clientPrincipal) => {
    for (;;) {
      const index = issued++;
      if (index >= total) return;
      const result = await fn(clientPrincipal, index);
      if (result !== undefined) samples.push(result);
    }
  };
  await Promise.all(clients.map(worker));
  return samples;
}

// --- Approved read latency -------------------------------------------------
const readLatencies = await sampleConcurrent(READ_SAMPLES, async (c, i) => {
  const prompt = prompts[i % prompts.length];
  const { status, ms } = await api(`/workspaces/${workspaceId}/prompts/${prompt.prompt_id}`, authed(c));
  return status === 200 ? ms : undefined;
});
if (readLatencies.length < READ_SAMPLES) {
  console.error(`team:benchmark: ${READ_SAMPLES - readLatencies.length} reads failed — aborting (server health).`);
  client.release();
  await pool.end();
  process.exit(1);
}

// --- Search latency --------------------------------------------------------
const searchLatencies = await sampleConcurrent(READ_SAMPLES, async (c, i) => {
  const { status, ms } = await api(`/workspaces/${workspaceId}/prompts?q=${encodeURIComponent(`synthetic benchmark prompt ${i % 1000}`)}`, authed(c));
  return status === 200 ? ms : undefined;
});

// --- Command acceptance (proposal.submit) ---------------------------------
const commandLatencies = [];
for (let i = 0; i < COMMAND_SAMPLES; i++) {
  const c = clients[i % clients.length];
  const prompt = prompts[i % prompts.length];
  const started = performance.now();
  const response = await fetch(`${ORIGIN}/api/team/v1/workspaces/${workspaceId}/commands`, {
    method: "POST",
    headers: { ...HEADERS, authorization: `Bearer ${c.token}`, "x-promptbranch-team-epoch": epoch },
    body: JSON.stringify({
      commandId: randomUUID(),
      membershipGeneration: c.generation,
      operation: {
        type: "proposal.submit",
        promptId: prompt.prompt_id,
        baseRevisionId: prompt.approved_revision_id,
        content: `synthetic-bench proposal ${i}\nproposal canary body`,
        rationale: `benchmark proposal ${i}`,
        supersedesProposalId: null,
      },
    }),
  });
  const body = (await response.json());
  if (response.status !== 200) {
    console.error(`team:benchmark: command ${i} rejected ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
    client.release();
  await pool.end();
    process.exit(1);
  }
  commandLatencies.push(performance.now() - started);
}

// --- Bootstrap duration ----------------------------------------------------
const bootStarted = performance.now();
const bootResponse = await fetch(`${ORIGIN}/api/team/v1/workspaces/${workspaceId}/bootstrap`, {
  method: "POST",
  headers: { ...HEADERS, authorization: `Bearer ${clients[0].token}` },
  body: JSON.stringify({ membershipGeneration: clients[0].generation, serverEpoch: epoch }),
});
const boot = (await bootResponse.json());
if (bootResponse.status !== 201 && bootResponse.status !== 200) {
  console.error(`team:benchmark: bootstrap failed ${bootResponse.status}`);
  client.release();
  await pool.end();
  process.exit(1);
}
let bootstrapBytes = 0;
let pageToken;
for (;;) {
  const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
  const page = await fetch(`${ORIGIN}/api/team/v1/workspaces/${workspaceId}/bootstrap/${boot.snapshotId}${query}`, {
    headers: { ...HEADERS, authorization: `Bearer ${clients[0].token}` },
  });
  if (page.status !== 200) {
    console.error(`team:benchmark: bootstrap page failed ${page.status}`);
    client.release();
    await pool.end();
    process.exit(1);
  }
  const text = await page.text();
  bootstrapBytes += text.length;
  pageToken = (JSON.parse(text)).nextPageToken ?? null;
  if (!pageToken) break;
}
const bootstrapMs = performance.now() - bootStarted;

// --- Second-client feed visibility ----------------------------------------
// A committed CATALOGUE write must reach another client's feed quickly.
// Proposals never enter the feed (candidates are invisible until approved),
// so the probe drives a real catalogue command (prompt.create) through the
// same dispatch path the API uses — in-process, against the same database —
// and measures HTTP feed visibility for a DIFFERENT client.
const visibilityStarted = performance.now();
// A human owner web session is forged straight into the database (the same
// construction the ops suite uses; the key is shared with the server), and
// the catalogue command is driven over REAL HTTP with the CSRF pair.
const { Sessions } = await import(dist("auth/sessions.js"));
const { SecretBox } = await import(dist("auth/crypto.js"));
const sessions = new Sessions(pool, SecretBox.fromBase64(process.env.TEAM_SESSION_ENCRYPTION_KEY));
const ownerRow = (await pool.query("SELECT verified_email FROM team_users WHERE id = $1", [ownerUserId])).rows[0];
const mapped = await sessions.mapUser({ issuer: "http://bench.invalid", subject: "bench-owner", email: ownerRow.verified_email, displayName: "Bench Owner" });
const app = await sessions.resolveAppSession({ issuer: "http://bench.invalid", subject: "bench-owner", providerSessionId: "bench-owner", clientId: "promptbranch-desktop" }, mapped.userId);
const web = await sessions.createWebSession({ appSessionId: app.appSessionId, refreshToken: null });
const ownerGeneration = (await pool.query("SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL", [workspaceId, ownerUserId])).rows[0].generation;
const submitResponse = await fetch(`${ORIGIN}/api/team/v1/workspaces/${workspaceId}/commands`, {
  method: "POST",
  headers: {
    ...HEADERS,
    "x-promptbranch-team-epoch": epoch,
    cookie: `__Host-pb-team=${web.token}`,
    "x-pb-team-csrf": web.csrfToken,
    origin: ORIGIN,
  },
  body: JSON.stringify({
    commandId: randomUUID(),
    membershipGeneration: ownerGeneration,
    operation: {
      type: "prompt.create",
      title: "Synthetic visibility probe",
      description: "",
      content: `synthetic-bench visibility probe ${randomUUID()}`,
      tagIds: [],
      collectionIds: [],
      changeNote: "visibility probe",
    },
  }),
});
const writeReceipt = await submitResponse.json();
if (submitResponse.status !== 200) {
  console.error(`team:benchmark: visibility write failed ${submitResponse.status}: ${JSON.stringify(writeReceipt).slice(0, 200)}`);
  client.release();
  await pool.end();
  process.exit(1);
}
const targetSeq = writeReceipt.catalogSeq;
let visibilityMs = -1;
for (;;) {
  const changes = await api(
    `/workspaces/${workspaceId}/changes?after=0&serverEpoch=${epoch}&membershipGeneration=${clients[1].generation}`,
    authed(clients[1]),
  );
  const body = (await changes.response.json());
  if (changes.status === 200 && body.changes.some((change) => Number(change.seq) >= Number(targetSeq))) {
    visibilityMs = performance.now() - visibilityStarted;
    break;
  }
  if (performance.now() - visibilityStarted > 35_000) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// --- Cleanup: purge the synthetic workspace through the product lifecycle.
{
  const { runPurgeSweep } = await import(dist("domain/purge.js"));
  await client.query("UPDATE team_workspaces SET deleted_at = now(), purge_after = now() - interval '1 second' WHERE id = $1", [workspaceId]);
  await client.query(`DELETE FROM team_audit WHERE workspace_id = $1`, [workspaceId]);
  await runPurgeSweep(pool);
  client.release();
  await pool.end();
}

// --- Receipt ---------------------------------------------------------------
const receipt = {
  origin: ORIGIN,
  dataset: { prompts: prompts.length, revisions: 10 * prompts.length, clients: clients.length },
  samples: { reads: readLatencies.length, searches: searchLatencies.length, commands: commandLatencies.length },
  readP50Ms: Math.round(percentile(readLatencies, 50)),
  readP95Ms: Math.round(percentile(readLatencies, 95)),
  searchP50Ms: Math.round(percentile(searchLatencies, 50)),
  searchP95Ms: Math.round(percentile(searchLatencies, 95)),
  commandP95Ms: Math.round(percentile(commandLatencies, 95)),
  bootstrapMs: Math.round(bootstrapMs),
  bootstrapBytes,
  feedVisibilityMs: visibilityMs >= 0 ? Math.round(visibilityMs) : null,
  content: "synthetic (synthetic-bench-canary markers; no real prompts)",
};
console.log(JSON.stringify(receipt, null, 2));

const failures = [];
if (receipt.readP95Ms > TARGETS.readP95Ms) failures.push(`read p95 ${receipt.readP95Ms}ms > ${TARGETS.readP95Ms}ms`);
if (receipt.searchP95Ms > TARGETS.searchP95Ms) failures.push(`search p95 ${receipt.searchP95Ms}ms > ${TARGETS.searchP95Ms}ms`);
if (receipt.commandP95Ms > TARGETS.commandP95Ms) failures.push(`command p95 ${receipt.commandP95Ms}ms > ${TARGETS.commandP95Ms}ms`);
if (receipt.bootstrapMs > TARGETS.bootstrapMs) failures.push(`bootstrap ${receipt.bootstrapMs}ms > ${TARGETS.bootstrapMs}ms`);
if (receipt.feedVisibilityMs === null || receipt.feedVisibilityMs > TARGETS.feedVisibilityMs) {
  failures.push(`feed visibility ${receipt.feedVisibilityMs ?? "timeout"} > ${TARGETS.feedVisibilityMs}ms`);
}
if (failures.length > 0) {
  console.error(`team:benchmark: LAUNCH-BLOCKING target misses:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("team:benchmark: all contract readiness targets met.");
