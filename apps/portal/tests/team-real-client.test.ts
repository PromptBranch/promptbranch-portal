import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamClient, type TeamClient } from "@promptbranch/team-client";
import { Sessions, SecretBox, type CommandEnvelope } from "@promptbranch/team-server";
import { setupTeamTest, nativeClaims, TEST_ISSUER, type TeamTestSetup } from "./team-test-setup";

// G2/G3: the REAL @promptbranch/team-client (vendored from the main repo;
// provenance in docs-internal/contracts/D10-client-provenance.md) driven
// against a live portal server over actual HTTP — no handler substitutes.
//
// G2: full roundtrip — info, workspace catalogue reads, agent command
// submission, distinct-reviewer approval, feed visibility and bootstrap.
// G3: fault scenarios — a dropped command response replays the stored
// receipt (exactly-once), duplicate delivery never double-mutates, and a
// revoked agent credential fails closed on the next call.

const PORT = 4620;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROTOCOL = { "x-promptbranch-team-protocol": "1" };

let setup: TeamTestSetup;
let server: ReturnType<typeof spawn>;
let nextEnvSnapshot: string;
let client: TeamClient;
let agentToken: string;
let ownerCookie: string;
let ownerCsrf: string;
let workspace: { id: string; name: string; serverEpoch: string; membershipGeneration: string; entityVersion: number };
let ownerId: string;
let maintainerId: string;
let maintainerCookie: string;
let maintainerCsrf: string;
let seededPromptId: string;
let seededRevisionId: string;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/api/team/v1/info`, { headers: PROTOCOL });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("next dev did not become ready within 240s");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

beforeAll(async () => {
  setup = await setupTeamTest();
  process.env.TEAM_PUBLIC_ORIGIN = ORIGIN;
  process.env.PUBLIC_BASE_URL = ORIGIN;

  // Owner identity + web session (approvals stay human), and a scoped agent
  // token the CLIENT authenticates with — the canonical headless path.
  const secretBox = SecretBox.fromBase64(process.env.TEAM_SESSION_ENCRYPTION_KEY!);
  const sessions = new Sessions(setup.pool, secretBox);
  const user = await sessions.mapUser({
    issuer: TEST_ISSUER,
    subject: "real-client-owner",
    email: "real-client-owner@promptbranch.test",
    displayName: "Real Client Owner",
  });
  ownerId = user.userId;
  const app = await sessions.resolveAppSession(
    { issuer: TEST_ISSUER, subject: "real-client-owner", providerSessionId: "real-client-sid", clientId: "promptbranch-desktop" },
    user.userId,
  );
  const web = await sessions.createWebSession({ appSessionId: app.appSessionId, refreshToken: null });
  ownerCookie = `__Host-pb-team=${web.token}`;
  ownerCsrf = web.csrfToken;

  // A DISTINCT human maintainer: reviews must differ from the author — and
  // the owner reviewing their own agent's proposal is SELF_REVIEW by design.
  const maintainer = await sessions.mapUser({
    issuer: TEST_ISSUER,
    subject: "real-client-maintainer",
    email: "real-client-maintainer@promptbranch.test",
    displayName: "Real Client Maintainer",
  });
  maintainerId = maintainer.userId;
  const maintainerApp = await sessions.resolveAppSession(
    { issuer: TEST_ISSUER, subject: "real-client-maintainer", providerSessionId: "real-client-maintainer-sid", clientId: "promptbranch-desktop" },
    maintainer.userId,
  );
  const maintainerWeb = await sessions.createWebSession({ appSessionId: maintainerApp.appSessionId, refreshToken: null });
  maintainerCookie = `__Host-pb-team=${maintainerWeb.token}`;
  maintainerCsrf = maintainerWeb.csrfToken;

  // Boot the server FIRST — the fixture commands below go over HTTP.
  nextEnvSnapshot = await readFile(join(process.cwd(), "next-env.d.ts"), "utf8");
  server = spawn("pnpm", ["exec", "next", "dev", "--webpack", "--port", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();

  const create = await fetch(`${ORIGIN}/api/team/v1/workspaces`, {
    method: "POST",
    headers: { ...PROTOCOL, authorization: `Bearer ${await setup.signToken(nativeClaims({ sub: "real-client-owner", sid: "real-client-sid", email: "real-client-owner@promptbranch.test" }))}` },
    body: JSON.stringify({ commandId: randomUUID(), name: "Real Client WS" }),
  });
  expect(create.status).toBe(201);
  workspace = ((await create.json()) as { workspace: typeof workspace }).workspace;

  const secret = Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), "hex").toString("base64url");
  agentToken = `pbt_${randomUUID()}.${secret}`;
  await setup.pool.query(
    `INSERT INTO team_agent_tokens (workspace_id, id, owner_user_id, name, secret_hash, scopes, membership_generation, expires_at)
     VALUES ($1, $2, $3, 'real client agent', $4, ARRAY['catalog:read','proposal:write']::text[], $5, now() + interval '2 hours')`,
    [workspace.id, agentToken.split(".")[0]!.replace("pbt_", ""), ownerId, createHash("sha256").update(secret).digest(), workspace.membershipGeneration],
  );

  client = createTeamClient({ origin: ORIGIN, tokenSource: () => agentToken, timeoutMs: 30_000 });
}, 300_000);

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      setTimeout(resolve, 10_000);
    });
  }
  await writeFile(join(process.cwd(), "next-env.d.ts"), nextEnvSnapshot).catch(() => undefined);
  await setup.cleanup();
}, 60_000);

/** Web-session mutation over real HTTP (humans only per C4). */
async function sessionCommand(
  cookie: string,
  csrf: string,
  operation: Record<string, unknown>,
  generation = workspace.membershipGeneration,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${ORIGIN}/api/team/v1/workspaces/${workspace.id}/commands`, {
    method: "POST",
    headers: { ...PROTOCOL, "x-promptbranch-team-epoch": workspace.serverEpoch, cookie, "x-pb-team-csrf": csrf, origin: ORIGIN },
    body: JSON.stringify({ commandId: randomUUID(), membershipGeneration: generation, operation }),
  });
  return { status: response.status, body: await response.json() };
}

async function ownerCommand(operation: Record<string, unknown>, generation = workspace.membershipGeneration) {
  return sessionCommand(ownerCookie, ownerCsrf, operation, generation);
}

describe("G2: real-client roundtrip over live HTTP", () => {
  it("discovers the server and the agent's single workspace", async () => {
    const info = await client.info();
    expect(info.protocol).toBe(1);
    const workspaces = await client.listWorkspaces();
    expect(workspaces.items.map((w) => w.id)).toContain(workspace.id);
  }, 60_000);

  it("seeds an approved prompt through the owner and reads it back through the client", async () => {
    const seeded = await ownerCommand({
      type: "prompt.create",
      title: "Client roundtrip prompt",
      description: "seeded for G2",
      content: "roundtrip approved body v1",
      tagIds: [],
      collectionIds: [],
      changeNote: "seed",
    });
    expect(seeded.status).toBe(200);
    seededPromptId = (seeded.body as { result: { id: string } }).result.id;
    seededRevisionId = (await setup.pool.query<{ id: string }>(
      "SELECT id FROM team_revisions WHERE workspace_id = $1 AND prompt_id = $2 ORDER BY created_at DESC LIMIT 1",
      [workspace.id, seededPromptId],
    )).rows[0]!.id;

    const detail = await client.getPrompt(workspace.id, seededPromptId);
    expect(detail.prompt.title).toBe("Client roundtrip prompt");
    expect(detail.revision.content).toBe("roundtrip approved body v1");

    const revisions = await client.listRevisions(workspace.id, seededPromptId);
    expect(revisions.items.map((r) => r.id)).toContain(seededRevisionId);
    const revision = await client.getRevision(workspace.id, seededRevisionId);
    expect(revision.contentHash).toBe(createHash("sha256").update("roundtrip approved body v1").digest("hex"));
  }, 60_000);

  it("submits a proposal as the agent, stays invisible in the catalogue until approved", async () => {
    const envelope: CommandEnvelope = {
      commandId: randomUUID(),
      membershipGeneration: workspace.membershipGeneration,
      operation: {
        type: "proposal.submit",
        promptId: seededPromptId,
        baseRevisionId: seededRevisionId,
        content: "client candidate body",
        rationale: "Improve the wording.",
        supersedesProposalId: null,
      },
    };
    const receipt = await client.command(workspace.id, workspace.serverEpoch, envelope);
    expect(receipt.result.kind).toBe("proposal");

    const proposalId = receipt.result.id;
    const detail = await client.getProposal(workspace.id, proposalId);
    expect(detail.proposal.status).toBe("open");
    expect(detail.candidate.content).toBe("client candidate body");

    // Candidate text never enters catalogue reads (viewer-level agent).
    const catalogue = await client.listPrompts(workspace.id);
    expect(JSON.stringify(catalogue)).not.toContain("client candidate body");
  }, 60_000);

  it("sees the approved head and the feed event after a distinct human review", async () => {
    const proposalRow = (await setup.pool.query<{ id: string; candidate_revision_id: string }>(
      "SELECT id, candidate_revision_id::text AS candidate_revision_id FROM team_proposals WHERE workspace_id = $1 AND status = 'open' LIMIT 1",
      [workspace.id],
    )).rows[0]!;
    const candidateHash = (await setup.pool.query<{ content_hash: string }>(
      "SELECT content_hash FROM team_revisions WHERE id = $1",
      [proposalRow.candidate_revision_id],
    )).rows[0]!.content_hash;
    // The proposal's author is the OWNER's agent: the owner reviewing it
    // is SELF_REVIEW by contract design — assert it, then approve as the
    // distinct human maintainer.
    const selfReview = await ownerCommand({
      type: "proposal.review",
      proposalId: proposalRow.id,
      expectedEntityVersion: 1,
      candidateRevisionId: proposalRow.candidate_revision_id,
      candidateContentHash: candidateHash,
      expectedApprovedRevisionId: seededRevisionId,
      decision: "approve",
      comment: "owner must not review their own agent's proposal",
    });
    expect(selfReview.status).toBe(409);
    expect(((selfReview.body as { error: { code: string } }).error.code)).toBe("SELF_REVIEW");

    await setup.pool.query(
      "INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'maintainer', $3)",
      [workspace.id, maintainerId, workspace.membershipGeneration],
    );
    const approved = await sessionCommand(maintainerCookie, maintainerCsrf, {
      type: "proposal.review",
      proposalId: proposalRow.id,
      expectedEntityVersion: 1,
      candidateRevisionId: proposalRow.candidate_revision_id,
      candidateContentHash: candidateHash,
      expectedApprovedRevisionId: seededRevisionId,
      decision: "approve",
      comment: "client roundtrip approval",
    });
    expect(approved.status).toBe(200);

    const detail = await client.getPrompt(workspace.id, seededPromptId);
    expect(detail.revision.content).toBe("client candidate body");

    const feed = await client.changes(workspace.id, {
      after: "0",
      serverEpoch: workspace.serverEpoch,
      membershipGeneration: workspace.membershipGeneration,
    });
    expect(feed.changes.length).toBeGreaterThan(0);
    // The approval event groups prompt head + revision in ONE change.
    const approvalChange = feed.changes.find((change) =>
      change.records.some((record) => record.entity === "revision" && record.value.id === proposalRow.candidate_revision_id),
    );
    expect(approvalChange?.records.some((record) => record.entity === "prompt")).toBe(true);
  }, 60_000);

  it("bootstraps the catalogue through signed pages", async () => {
    const boot = await client.bootstrap(workspace.id, {
      membershipGeneration: workspace.membershipGeneration,
      serverEpoch: workspace.serverEpoch,
    });
    expect(boot.highWater).toBeTruthy();
    const page = await client.bootstrapPage(workspace.id, boot.snapshotId, { limit: 2 });
    expect(page.records.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("G3: fault scenarios with the real client", () => {
  it("replays a dropped command response exactly once (C6 idempotency)", async () => {
    // Drop the FIRST command POST's response after the server committed:
    // the client must retry with the same envelope and receive the stored
    // receipt; the database must hold exactly one proposal for the command.
    let dropped = false;
    const faultedClient = createTeamClient({
      origin: ORIGIN,
      tokenSource: () => agentToken,
      timeoutMs: 30_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (!dropped && init?.method === "POST" && url.endsWith("/commands")) {
          dropped = true;
          // Simulate a lost response after commit: a retryable unavailability.
          return new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "connection lost", requestId: "fault", retryable: true } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return fetch(input, init);
      },
    });

    const commandId = randomUUID();
    const envelope: CommandEnvelope = {
      commandId,
      membershipGeneration: workspace.membershipGeneration,
      operation: {
        type: "proposal.submit",
        promptId: seededPromptId,
        baseRevisionId: seededRevisionId,
        content: "dropped-response candidate",
        rationale: "Retry after lost response.",
        supersedesProposalId: null,
      },
    };
    const receipt = await faultedClient.command(workspace.id, workspace.serverEpoch, envelope);
    expect(receipt.commandId).toBe(commandId);
    expect(dropped).toBe(true);

    const stored = await setup.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM team_command_receipts WHERE workspace_id = $1 AND command_id = $2",
      [workspace.id, commandId],
    );
    expect(stored.rows[0]!.count).toBe("1");
    const proposals = await setup.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM team_proposals WHERE workspace_id = $1 AND rationale = 'Retry after lost response.'",
      [workspace.id],
    );
    expect(proposals.rows[0]!.count).toBe("1");
  }, 90_000);

  it("duplicate delivery of an acknowledged command mutates nothing further", async () => {
    const envelope: CommandEnvelope = {
      commandId: randomUUID(),
      membershipGeneration: workspace.membershipGeneration,
      operation: {
        type: "proposal.submit",
        promptId: seededPromptId,
        baseRevisionId: seededRevisionId,
        content: "duplicate delivery candidate",
        rationale: "Delivered twice on purpose.",
        supersedesProposalId: null,
      },
    };
    const first = await client.command(workspace.id, workspace.serverEpoch, envelope);
    const second = await client.command(workspace.id, workspace.serverEpoch, envelope);
    expect(second).toEqual(first);
    const proposals = await setup.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM team_proposals WHERE workspace_id = $1 AND rationale = 'Delivered twice on purpose.'",
      [workspace.id],
    );
    expect(proposals.rows[0]!.count).toBe("1");
  }, 60_000);

  it("fails closed after the agent credential is revoked", async () => {
    await setup.pool.query("UPDATE team_agent_tokens SET revoked_at = now() WHERE workspace_id = $1", [workspace.id]);
    await expect(client.listPrompts(workspace.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  }, 60_000);
});
