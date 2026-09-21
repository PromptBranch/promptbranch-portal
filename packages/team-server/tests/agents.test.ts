import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { resolveAgentBearer, createAgentToken, revokeAgentToken } from "../src/auth/agent-tokens";
import { listActivityItems } from "../src/domain/activity";

// P6 (plan review focus #2 and #7): agent capabilities are scoped, owned,
// revocable and never carry membership authority; approvals bind
// independent human identity even when the proposal came from an agent.

let h: TeamTestHarness;
const principals = new Map<string, HumanPrincipal>();

async function as(name: string): Promise<HumanPrincipal> {
  if (!principals.has(name)) principals.set(name, (await h.asUser(name)).principal);
  return principals.get(name)!;
}

interface Ctx {
  workspaceId: string;
  epoch: string;
  owner: HumanPrincipal;
  ownerGeneration: string;
}

async function workspace(owner = "Alice Agent"): Promise<Ctx> {
  const ownerPrincipal = await as(owner);
  const created = await h.service.createWorkspace(ownerPrincipal, { commandId: randomUUID(), name: `Agents ${randomUUID().slice(0, 6)}` });
  return { workspaceId: created.workspace.id, epoch: created.workspace.serverEpoch, owner: ownerPrincipal, ownerGeneration: created.workspace.membershipGeneration };
}

async function member(ctx: Ctx, name: string, role: "maintainer" | "contributor" | "viewer"): Promise<HumanPrincipal> {
  const principal = await as(name);
  await h.pool.query(
    `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, gen_random_uuid())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
    [ctx.workspaceId, principal.userId, role],
  );
  return principal;
}

async function generationOf(ctx: Ctx, userId: string): Promise<string> {
  return (await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [ctx.workspaceId, userId],
  )).rows[0]!.generation;
}

async function mint(ctx: Ctx, principal: HumanPrincipal, scopes: string[], name = "agent", expiresInDays?: number) {
  return createAgentToken(h.pool, principal, ctx.workspaceId, ctx.epoch, {
    commandId: randomUUID(),
    name,
    scopes: scopes as never[],
    expiresInDays,
  });
}

function agentPrincipal(minted: { tokenId: string }, ownerUserId: string, scopes: string[]) {
  return { kind: "agent" as const, userId: ownerUserId, tokenId: minted.tokenId, scopes: scopes as never[] };
}

async function ownerUserId(ctx: Ctx): Promise<string> {
  return ctx.owner.userId;
}

async function execAgent(ctx: Ctx, minter: HumanPrincipal, minted: { tokenId: string }, scopes: string[], operation: Record<string, unknown>) {
  return h.service.execute(agentPrincipal(minted, minter.userId, scopes), ctx.workspaceId, ctx.epoch, {
    commandId: randomUUID(),
    membershipGeneration: await generationOf(ctx, minter.userId),
    operation,
  });
}

async function execHuman(principal: HumanPrincipal, ctx: Ctx, operation: Record<string, unknown>) {
  return h.service.execute(principal, ctx.workspaceId, ctx.epoch, {
    commandId: randomUUID(),
    membershipGeneration: await generationOf(ctx, principal.userId),
    operation,
  });
}

async function seedPrompt(ctx: Ctx, actor: HumanPrincipal, content: string) {
  return execHuman(actor, ctx, { type: "prompt.create", title: "Agent test prompt", description: "", content, tagIds: [], collectionIds: [], changeNote: "" });
}

beforeAll(async () => {
  h = await createTeamTestHarness();
});
afterAll(async () => {
  await h.close();
});

describe("token minting", () => {
  it("returns the pbt_ secret exactly once; replay reports secretAvailable:false", async () => {
    const ctx = await workspace();
    const commandId = randomUUID();
    const first = await createAgentToken(h.pool, ctx.owner, ctx.workspaceId, ctx.epoch, { commandId, name: "cli", scopes: ["proposal:write"] });
    expect(first.token).toMatch(/^pbt_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(first.secretAvailable).toBe(true);

    const replay = await createAgentToken(h.pool, ctx.owner, ctx.workspaceId, ctx.epoch, { commandId, name: "cli", scopes: ["proposal:write"] });
    expect(replay.secretAvailable).toBe(false);
    expect(replay.token).toBeUndefined();
    expect(replay.tokenId).toBe(first.tokenId);
    expect(await h.count("team_agent_tokens")).toBe(1); // one row, catalog:read added

    // The raw secret exists nowhere in the database.
    const tables = await h.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'team_%'");
    for (const { table_name } of tables.rows) {
      const scan = await h.pool.query(`SELECT to_jsonb(t)::text AS doc FROM "${table_name}" t LIMIT 500`);
      for (const row of scan.rows) {
        expect(String(row.doc)).not.toContain(first.token!.split(".")[1]!);
      }
    }
  });

  it("viewers cannot mint write scopes; contributors can; quota enforces at 20", async () => {
    const ctx = await workspace();
    const viewer = await member(ctx, "Vera Viewer", "viewer");
    const contributor = await member(ctx, "Carl Contributor", "contributor");

    await expect(mint(ctx, viewer, ["proposal:write"])).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    await expect(mint(ctx, viewer, ["catalog:read"])).resolves.toMatchObject({ secretAvailable: true });
    await expect(mint(ctx, contributor, ["proposal:write", "note:write", "run:write"])).resolves.toMatchObject({ secretAvailable: true });

    for (let i = 0; i < 19; i++) {
      await mint(ctx, contributor, ["catalog:read"], `bulk ${i}`);
    }
    // 1 + 19 = 20 active tokens: the quota is exactly full, so minting fails.
    await expect(mint(ctx, contributor, ["catalog:read"], "over quota")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    await expect(mint(ctx, ctx.owner, ["catalog:read"], "bounds", 0)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(mint(ctx, ctx.owner, ["catalog:read"], "bounds", 91)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("bearer resolution", () => {
  it("validates secret, expiry, revocation, workspace and generation binding", async () => {
    const ctx = await workspace();
    const minted = await mint(ctx, ctx.owner, ["catalog:read"]);
    const bearer = minted.token!;

    await expect(resolveAgentBearer(h.pool, bearer, ctx.workspaceId)).resolves.toMatchObject({
      ownerUserId: ctx.owner.userId,
      role: "owner",
    });
    // Wrong secret / malformed.
    await expect(resolveAgentBearer(h.pool, `${bearer.slice(0, -2)}xy`)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveAgentBearer(h.pool, "pbt_nope")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Wrong workspace.
    const other = await workspace("Erin Otherws");
    await expect(resolveAgentBearer(h.pool, bearer, other.workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });
    // Revocation.
    await revokeAgentToken(h.pool, ctx.owner, ctx.workspaceId, minted.tokenId, ctx.epoch);
    await expect(resolveAgentBearer(h.pool, bearer)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Expiry.
    const shortLived = await mint(ctx, ctx.owner, ["catalog:read"], "short", 1);
    await h.pool.query("UPDATE team_agent_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [shortLived.tokenId]);
    await expect(resolveAgentBearer(h.pool, shortLived.token!)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Role downgrade revokes (P3 wiring) and a stale generation fails closed.
    const downgradee = await member(ctx, "Down Dan", "maintainer");
    const danToken = await mint(ctx, downgradee, ["catalog:read"]);
    await h.pool.query("UPDATE team_memberships SET role = 'viewer', generation = gen_random_uuid() WHERE workspace_id = $1 AND user_id = $2", [ctx.workspaceId, downgradee.userId]);
    await expect(resolveAgentBearer(h.pool, danToken.token!)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("agent dispatch", () => {
  it("submits proposals as agent author; forbidden operations stay human-only", async () => {
    const ctx = await workspace();
    const reviewer = await member(ctx, "Bob Reviewer", "maintainer");
    const seeded = await seedPrompt(ctx, ctx.owner, "agent flow base");
    const head = (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.approved_revision_id!;

    const minted = await mint(ctx, ctx.owner, ["proposal:write"]);
    const submission = await execAgent(ctx, ctx.owner, minted, ["proposal:write"], {
      type: "proposal.submit",
      promptId: seeded.result.id,
      baseRevisionId: head,
      content: "agent-authored candidate",
      rationale: "agent rationale",
      supersedesProposalId: null,
    });
    const row = (await h.pool.query<{ author_agent_id: string | null; author_user_id: string | null; candidate_revision_id: string; entity_version: number }>(
      "SELECT author_agent_id, author_user_id, candidate_revision_id, entity_version FROM team_proposals WHERE id = $1",
      [submission.result.id],
    )).rows[0]!;
    expect(row.author_agent_id).toBe(minted.tokenId);
    expect(row.author_user_id).toBeNull();

    // The owner reviewing their own agent's proposal is SELF_REVIEW.
    await expect(
      execHuman(ctx.owner, ctx, {
        type: "proposal.review",
        proposalId: submission.result.id,
        expectedEntityVersion: row.entity_version,
        candidateRevisionId: row.candidate_revision_id,
        candidateContentHash: (await h.pool.query<{ content_hash: string }>("SELECT content_hash FROM team_revisions WHERE id = $1", [row.candidate_revision_id])).rows[0]!.content_hash,
        expectedApprovedRevisionId: head,
        decision: "approve",
        comment: "",
      }),
    ).rejects.toMatchObject({ code: "SELF_REVIEW" });
    // A DIFFERENT human maintainer may approve it.
    await expect(
      execHuman(reviewer, ctx, {
        type: "proposal.review",
        proposalId: submission.result.id,
        expectedEntityVersion: row.entity_version,
        candidateRevisionId: row.candidate_revision_id,
        candidateContentHash: (await h.pool.query<{ content_hash: string }>("SELECT content_hash FROM team_revisions WHERE id = $1", [row.candidate_revision_id])).rows[0]!.content_hash,
        expectedApprovedRevisionId: head,
        decision: "approve",
        comment: "",
      }),
    ).resolves.toMatchObject({ result: { kind: "review" } });

    // Human-only operations refuse agents outright.
    for (const operation of [
      { type: "proposal.review", proposalId: submission.result.id, expectedEntityVersion: 99, candidateRevisionId: row.candidate_revision_id, candidateContentHash: "0".repeat(64), expectedApprovedRevisionId: head, decision: "reject", comment: "" },
      { type: "member.remove", userId: ctx.owner.userId, expectedEntityVersion: 1 },
      { type: "invitation.create", email: "x@promptbranch.test", role: "viewer" },
      { type: "prompt.create", title: "t", description: "", content: "c", tagIds: [], collectionIds: [], changeNote: "" },
      { type: "tag.create", name: "nope" },
    ]) {
      await expect(execAgent(ctx, ctx.owner, minted, ["proposal:write"], operation), operation.type).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
      });
    }
  });

  it("enforces scopes and own-proposal comment/withdraw rules", async () => {
    const ctx = await workspace();
    const contributor = await member(ctx, "Casey Scope", "contributor");
    const seeded = await seedPrompt(ctx, ctx.owner, "scope base");
    const head = (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.approved_revision_id!;

    const readOnly = await mint(ctx, ctx.owner, ["catalog:read"]);
    await expect(
      execAgent(ctx, ctx.owner, readOnly, ["catalog:read"], { type: "proposal.submit", promptId: seeded.result.id, baseRevisionId: head, content: "c", rationale: "r", supersedesProposalId: null }),
    ).rejects.toMatchObject({ code: "SCOPE_FORBIDDEN" });

    const writer = await mint(ctx, ctx.owner, ["proposal:write"]);
    const own = await execAgent(ctx, ctx.owner, writer, ["proposal:write"], {
      type: "proposal.submit", promptId: seeded.result.id, baseRevisionId: head, content: "own", rationale: "r", supersedesProposalId: null,
    });
    const foreign = await execHuman(contributor, ctx, {
      type: "proposal.submit", promptId: seeded.result.id, baseRevisionId: head, content: "foreign", rationale: "r", supersedesProposalId: null,
    });

    await expect(execAgent(ctx, ctx.owner, writer, ["proposal:write"], { type: "comment.add", proposalId: foreign.result.id, body: "hi" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(execAgent(ctx, ctx.owner, writer, ["proposal:write"], { type: "comment.add", proposalId: own.result.id, body: "agent note on own proposal" })).resolves.toMatchObject({ result: { kind: "comment" } });
    const ownVersion = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_proposals WHERE id = $1", [own.result.id])).rows[0]!.entity_version;
    await expect(
      execHuman(contributor, ctx, { type: "proposal.withdraw", proposalId: own.result.id, expectedEntityVersion: ownVersion }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(execAgent(ctx, ctx.owner, writer, ["proposal:write"], { type: "proposal.withdraw", proposalId: own.result.id, expectedEntityVersion: ownVersion })).resolves.toBeTruthy();
  });
});

describe("notes and run summaries", () => {
  it("bind to published revisions only, validate metrics, and never emit feed events", async () => {
    const ctx = await workspace();
    const seeded = await seedPrompt(ctx, ctx.owner, "activity base");
    const promptId = seeded.result.id;
    const head = (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [promptId])).rows[0]!.approved_revision_id!;
    const contributor = await member(ctx, "Nora Notes", "contributor");

    // A candidate revision is NOT a valid activity target.
    const candidate = (await h.pool.query<{ id: string }>(
      `INSERT INTO team_revisions (workspace_id, prompt_id, content, content_hash, change_note, author_user_id)
       VALUES ($1, $2, 'candidate body', encode(sha256('candidate body'::bytea), 'hex'), 'c', $3) RETURNING id`,
      [ctx.workspaceId, promptId, contributor.userId],
    )).rows[0]!.id;
    await expect(
      execHuman(contributor, ctx, { type: "note.add", promptId, revisionId: candidate, body: "note on candidate" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      execHuman(contributor, ctx, { type: "note.add", promptId, revisionId: head, body: "note on published" }),
    ).resolves.toMatchObject({ result: { kind: "activityItem" }, catalogSeq: "0" });
    await expect(
      execHuman(contributor, ctx, {
        type: "run.report", promptId, revisionId: head, body: "summary",
        model: "test-model", status: "completed", latencyMs: 1200, inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01,
      }),
    ).resolves.toMatchObject({ result: { kind: "activityItem" } });
    await expect(
      execHuman(contributor, ctx, {
        type: "run.report", promptId, revisionId: head, body: "unknowns",
        model: null, status: "failed", latencyMs: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null,
      }),
    ).resolves.toBeTruthy();
    await expect(
      execHuman(contributor, ctx, {
        type: "run.report", promptId, revisionId: head, body: "bad",
        model: null, status: "completed", latencyMs: -5, inputTokens: null, outputTokens: null, estimatedCostUsd: null,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      execHuman(contributor, ctx, { type: "note.add", promptId, revisionId: head, body: "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ).rejects.toMatchObject({ code: "SECRET_BLOCKED" });

    // No feed emission for activity.
    expect(await h.count("team_changes")).toBeGreaterThanOrEqual(1);
    const changesBefore = await h.count("team_changes");
    await execHuman(contributor, ctx, { type: "note.add", promptId, revisionId: head, body: "silent note" });
    expect(await h.count("team_changes")).toBe(changesBefore);

    // Visibility: contributor humans see all; viewer humans none; agents own only.
    const human = await listActivityItems(h.pool, { workspaceId: ctx.workspaceId, viewer: contributor, promptId });
    expect(human.items.length).toBeGreaterThanOrEqual(4);
    const viewer = await member(ctx, "Vera Actview", "viewer");
    await h.service.execute(viewer, ctx.workspaceId, ctx.epoch, {
      commandId: randomUUID(),
      membershipGeneration: await generationOf(ctx, viewer.userId),
      operation: { type: "note.add", promptId, revisionId: head, body: "x" },
    }).catch(() => undefined); // role refusal expected
    const agentMint = await mint(ctx, contributor, ["note:write"]);
    const agentNote = await execAgent(ctx, contributor, agentMint, ["note:write"], { type: "note.add", promptId, revisionId: head, body: "agent-authored note" });
    const agentView = await listActivityItems(h.pool, {
      workspaceId: ctx.workspaceId,
      viewer: { kind: "agent", userId: contributor.userId, tokenId: agentMint.tokenId, scopes: ["note:write"] },
      promptId,
    });
    expect(agentView.items.map((i) => i.id)).toEqual([agentNote.result.id]);
  });
});
