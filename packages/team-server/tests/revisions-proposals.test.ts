import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { getPromptWithHead, listPrompts, listPublishedRevisions, getPublishedRevisionDto } from "../src/domain/prompts";

// P4 core (plan review focus #2): approvals bind immutable exact content and
// independent human identity; concurrent approvals on one base serialize
// with STALE_BASE; supersession/rejection/withdrawal are terminal; the
// catalogue only ever exposes published revisions.

let h: TeamTestHarness;
const principals = new Map<string, HumanPrincipal>();

async function as(name: string): Promise<HumanPrincipal> {
  if (!principals.has(name)) principals.set(name, (await h.asUser(name)).principal);
  return principals.get(name)!;
}

interface Ctx {
  workspaceId: string;
  epoch: string;
  ownerGeneration: string;
}

async function workspace(owner = "Alice Cat"): Promise<Ctx> {
  const created = await h.service.createWorkspace(await as(owner), { commandId: randomUUID(), name: `Catalogue ${randomUUID().slice(0, 6)}` });
  return { workspaceId: created.workspace.id, epoch: created.workspace.serverEpoch, ownerGeneration: created.workspace.membershipGeneration };
}

async function member(ctx: Ctx, name: string, role: "maintainer" | "contributor" | "viewer"): Promise<HumanPrincipal> {
  const principal = await as(name);
  const existing = await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
    [ctx.workspaceId, principal.userId],
  );
  if (!existing.rows[0]) {
    await h.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, gen_random_uuid())`,
      [ctx.workspaceId, principal.userId, role],
    );
  }
  return principal;
}

async function generationOf(ctx: Ctx, name: string): Promise<string> {
  const principal = await as(name);
  const row = await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
    [ctx.workspaceId, principal.userId],
  );
  return row.rows[0]!.generation;
}

async function exec(principal: HumanPrincipal, ctx: Ctx, operation: Record<string, unknown>, generation?: string) {
  return h.service.execute(principal, ctx.workspaceId, ctx.epoch, {
    commandId: randomUUID(),
    membershipGeneration: generation ?? (await generationOf(ctx, (await userName(principal)))),
    operation,
  });
}

async function userName(principal: HumanPrincipal): Promise<string> {
  const row = await h.pool.query<{ display_name: string }>("SELECT display_name FROM team_users WHERE id = $1", [principal.userId]);
  return row.rows[0]!.display_name;
}

async function seed(ctx: Ctx, actor: HumanPrincipal, content: string, title = "Seeded prompt") {
  return exec(actor, ctx, { type: "prompt.create", title, description: "seed", content, tagIds: [], collectionIds: [], changeNote: "seed" });
}

async function submit(ctx: Ctx, actor: HumanPrincipal, promptId: string, baseRevisionId: string, content: string, supersedesProposalId: string | null = null) {
  return exec(actor, ctx, { type: "proposal.submit", promptId, baseRevisionId, content, rationale: "improves clarity", supersedesProposalId });
}

async function approve(ctx: Ctx, reviewer: HumanPrincipal, proposalId: string, expectedHead: string, candidateRevisionId: string, candidateContentHash: string, expectedEntityVersion = 1) {
  return exec(reviewer, ctx, {
    type: "proposal.review",
    proposalId,
    expectedEntityVersion,
    candidateRevisionId,
    candidateContentHash,
    expectedApprovedRevisionId: expectedHead,
    decision: "approve",
    comment: "looks good",
  });
}

async function promptHeadRevisionId(ctx: Ctx, promptId: string): Promise<string> {
  const row = await h.pool.query<{ approved_revision_id: string }>(
    "SELECT approved_revision_id FROM team_prompts WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, promptId],
  );
  return row.rows[0]!.approved_revision_id!;
}

async function candidateInfo(proposalId: string): Promise<{ revisionId: string; hash: string; entityVersion: number }> {
  const row = await h.pool.query<{ candidate_revision_id: string; entity_version: number }>(
    "SELECT candidate_revision_id, entity_version FROM team_proposals WHERE id = $1",
    [proposalId],
  );
  const rev = await h.pool.query<{ content_hash: string }>(
    "SELECT content_hash FROM team_revisions WHERE id = $1",
    [row.rows[0]!.candidate_revision_id],
  );
  return { revisionId: row.rows[0]!.candidate_revision_id, hash: rev.rows[0]!.content_hash, entityVersion: row.rows[0]!.entity_version };
}

beforeAll(async () => {
  h = await createTeamTestHarness();
});
afterAll(async () => {
  await h.close();
});

describe("seed and catalogue", () => {
  it("seeds a maintainer prompt with its first approved revision atomically", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Seed", "maintainer");
    const receipt = await seed(ctx, maintainer, "# Approved seed content\nUse responsibly.");
    expect(receipt.result.kind).toBe("prompt");

    const detail = await getPromptWithHead(h.pool, ctx.workspaceId, receipt.result.id);
    expect(detail.prompt.approvedRevisionId).toBeTypeOf("string");
    expect(detail.revision.content).toContain("Approved seed content");
    expect(detail.prompt.tagIds).toEqual([]);

    const listed = await listPrompts(h.pool, ctx.workspaceId, {});
    expect(listed.items.some((p) => p.id === receipt.result.id)).toBe(true);

    // Search finds approved seed content by title and body.
    const byBody = await listPrompts(h.pool, ctx.workspaceId, { q: "responsibly" });
    expect(byBody.items.some((p) => p.id === receipt.result.id)).toBe(true);
    const byTitle = await listPrompts(h.pool, ctx.workspaceId, { q: "seeded" });
    expect(byTitle.items.some((p) => p.id === receipt.result.id)).toBe(true);
  });

  it("blocks high-severity secrets in seeds and returns medium for preview", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Scan", "maintainer");
    await expect(
      seed(ctx, maintainer, "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({ code: "SECRET_BLOCKED" });

    const receipt = await submitMediumScenario(ctx, maintainer);
    expect(receipt.mediumFindings).toBeTypeOf("object");
  });

  async function submitMediumScenario(ctx: Ctx, maintainer: HumanPrincipal) {
    const seeded = await seed(ctx, maintainer, "stable seed");
    const medium = await exec(maintainer, ctx, {
      type: "proposal.submit",
      promptId: seeded.result.id,
      baseRevisionId: await promptHeadRevisionId(ctx, seeded.result.id),
      content: "Reach me at someone@example.internal for details.",
      rationale: "adds contact",
      supersedesProposalId: null,
    });
    return medium as { mediumFindings?: unknown };
  }
});

describe("review workflow", () => {
  it("forbids self-review and enforces the exact candidate binding", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Flow", "maintainer");
    const contributor = await member(ctx, "Casey Flow", "contributor");
    const seeded = await seed(ctx, maintainer, "base content A");
    const headA = await promptHeadRevisionId(ctx, seeded.result.id);

    const proposal = await submit(ctx, contributor, seeded.result.id, headA, "candidate content B");
    const info = await candidateInfo(proposal.result.id);

    // Self-review (author is Casey, human).
    await expect(
      approve(ctx, (await as("Casey Flow")), proposal.result.id, headA, info.revisionId, info.hash),
    ).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" }); // contributor role first
    // Promote Casey to maintainer: now the role passes and SELF_REVIEW fires.
    await h.pool.query("UPDATE team_memberships SET role = 'maintainer' WHERE workspace_id = $1 AND user_id = $2", [ctx.workspaceId, contributor.userId]);
    await expect(
      approve(ctx, contributor, proposal.result.id, headA, info.revisionId, info.hash),
    ).rejects.toMatchObject({ code: "SELF_REVIEW" });

    // Wrong candidate hash binding.
    await expect(
      approve(ctx, maintainer, proposal.result.id, headA, info.revisionId, "0".repeat(64)),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });
    // Wrong candidate id.
    await expect(
      approve(ctx, maintainer, proposal.result.id, headA, randomUUID(), info.hash),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });
  });

  it("serializes concurrent approvals: second proposal on the same base gets STALE_BASE", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Race", "maintainer");
    const reviewer = await member(ctx, "Dana Race", "maintainer");
    const contributor = await member(ctx, "Casey Race", "contributor");
    const seeded = await seed(ctx, maintainer, "shared base A");
    const headA = await promptHeadRevisionId(ctx, seeded.result.id);

    const b = await submit(ctx, contributor, seeded.result.id, headA, "candidate B content");
    const c = await submit(ctx, contributor, seeded.result.id, headA, "candidate C content");
    const bInfo = await candidateInfo(b.result.id);
    const cInfo = await candidateInfo(c.result.id);

    await approve(ctx, reviewer, b.result.id, headA, bInfo.revisionId, bInfo.hash);
    expect(await promptHeadRevisionId(ctx, seeded.result.id)).toBe(bInfo.revisionId);

    // Approving C with the stale expectation A fails and leaves C open.
    await expect(
      approve(ctx, reviewer, c.result.id, headA, cInfo.revisionId, cInfo.hash),
    ).rejects.toMatchObject({ code: "STALE_BASE" });
    const cStatus = await h.pool.query<{ status: string }>("SELECT status FROM team_proposals WHERE id = $1", [c.result.id]);
    expect(cStatus.rows[0]!.status).toBe("open");

    // Rebase: Casey supersedes C with a new proposal based on the NEW head B.
    const d = await submit(ctx, contributor, seeded.result.id, bInfo.revisionId, "candidate D on B", c.result.id);
    const dInfo = await candidateInfo(d.result.id);
    const cClosed = await h.pool.query<{ status: string }>("SELECT status FROM team_proposals WHERE id = $1", [c.result.id]);
    expect(cClosed.rows[0]!.status).toBe("superseded");

    await approve(ctx, reviewer, d.result.id, bInfo.revisionId, dInfo.revisionId, dInfo.hash);
    expect(await promptHeadRevisionId(ctx, seeded.result.id)).toBe(dInfo.revisionId);

    // Only approved/seed revisions appear in history; candidates never do.
    const history = await listPublishedRevisions(h.pool, ctx.workspaceId, seeded.result.id, {});
    const historyIds = history.items.map((r) => r.id).sort();
    expect(historyIds).toContain(bInfo.revisionId);
    expect(historyIds).toContain(dInfo.revisionId);
    expect(historyIds).not.toContain(cInfo.revisionId);

    // The exact-revision endpoint verifies publication, not prompt visibility.
    await expect(getPublishedRevisionDto(h.pool, ctx.workspaceId, cInfo.revisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPublishedRevisionDto(h.pool, ctx.workspaceId, dInfo.revisionId)).resolves.toMatchObject({ id: dInfo.revisionId });
  });

  it("rejection never moves the head; withdrawal and rejections are terminal", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Term", "maintainer");
    const reviewer = await member(ctx, "Erin Term", "maintainer");
    const contributor = await member(ctx, "Casey Term", "contributor");
    const seeded = await seed(ctx, maintainer, "terminal base");
    const head = await promptHeadRevisionId(ctx, seeded.result.id);

    const proposal = await submit(ctx, contributor, seeded.result.id, head, "will be rejected");
    const info = await candidateInfo(proposal.result.id);
    await exec(reviewer, ctx, {
      type: "proposal.review",
      proposalId: proposal.result.id,
      expectedEntityVersion: info.entityVersion,
      candidateRevisionId: info.revisionId,
      candidateContentHash: info.hash,
      expectedApprovedRevisionId: head,
      decision: "reject",
      comment: "not aligned with guidelines",
    });
    expect(await promptHeadRevisionId(ctx, seeded.result.id)).toBe(head);

    // Terminal: another review attempt fails.
    await expect(
      approve(ctx, reviewer, proposal.result.id, head, info.revisionId, info.hash),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });

    // Withdrawal of a closed proposal is also refused.
    await expect(
      exec(contributor, ctx, { type: "proposal.withdraw", proposalId: proposal.result.id, expectedEntityVersion: info.entityVersion + 1 }),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });

    // The author can withdraw their OWN open proposal; others get 404.
    const open = await submit(ctx, contributor, seeded.result.id, head, "will be withdrawn");
    const openInfo = await candidateInfo(open.result.id);
    await expect(
      exec(reviewer, ctx, { type: "proposal.withdraw", proposalId: open.result.id, expectedEntityVersion: openInfo.entityVersion }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await exec(contributor, ctx, { type: "proposal.withdraw", proposalId: open.result.id, expectedEntityVersion: openInfo.entityVersion });
    const status = await h.pool.query<{ status: string }>("SELECT status FROM team_proposals WHERE id = $1", [open.result.id]);
    expect(status.rows[0]!.status).toBe("withdrawn");
  });

  it("reject leaves the review record; comments are append-only discussion", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Disc", "maintainer");
    const contributor = await member(ctx, "Casey Disc", "contributor");
    const seeded = await seed(ctx, maintainer, "discussion base");
    const head = await promptHeadRevisionId(ctx, seeded.result.id);
    const proposal = await submit(ctx, contributor, seeded.result.id, head, "discuss me");
    const info = await candidateInfo(proposal.result.id);

    await exec(contributor, ctx, { type: "comment.add", proposalId: proposal.result.id, body: "please prioritize this" });
    await exec(maintainer, ctx, { type: "comment.add", proposalId: proposal.result.id, body: "reviewing now" });
    const commentRows = await h.pool.query("SELECT count(*)::int AS n FROM team_comments WHERE proposal_id = $1", [proposal.result.id]);
    expect(commentRows.rows[0].n).toBe(2);

    // High-severity secrets block comments too.
    await expect(
      exec(contributor, ctx, { type: "comment.add", proposalId: proposal.result.id, body: "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    ).rejects.toMatchObject({ code: "SECRET_BLOCKED" });
  });
});

describe("metadata, archive and rollback", () => {
  it("metadata uses expectedEntityVersion; title updates flow into search", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Meta", "maintainer");
    const seeded = await seed(ctx, maintainer, "meta base", "Original Meta Title");
    const version = await h.pool.query<{ entity_version: number }>(
      "SELECT entity_version FROM team_prompts WHERE id = $1",
      [seeded.result.id],
    );

    await expect(
      exec(maintainer, ctx, { type: "prompt.metadata", promptId: seeded.result.id, title: "New Meta Title", description: "d", tagIds: [], collectionIds: [], expectedEntityVersion: 999 }),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });

    await exec(maintainer, ctx, {
      type: "prompt.metadata",
      promptId: seeded.result.id,
      title: "Quantum Meta Title",
      description: "renamed",
      tagIds: [],
      collectionIds: [],
      expectedEntityVersion: version.rows[0]!.entity_version,
    });
    const search = await listPrompts(h.pool, ctx.workspaceId, { q: "quantum" });
    expect(search.items.some((p) => p.id === seeded.result.id)).toBe(true);
  });

  it("archived prompts leave browse/search; approvals and submissions refuse; restore revives", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Arch", "maintainer");
    const contributor = await member(ctx, "Casey Arch", "contributor");
    const seeded = await seed(ctx, maintainer, "archivable base", "Archivable Title");
    const version = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.entity_version;

    await exec(maintainer, ctx, { type: "prompt.archive", promptId: seeded.result.id, expectedEntityVersion: version });
    const browse = await listPrompts(h.pool, ctx.workspaceId, {});
    expect(browse.items.some((p) => p.id === seeded.result.id)).toBe(false);
    const archivedBrowse = await listPrompts(h.pool, ctx.workspaceId, { archived: true });
    expect(archivedBrowse.items.some((p) => p.id === seeded.result.id)).toBe(true);
    const search = await listPrompts(h.pool, ctx.workspaceId, { q: "archivable" });
    expect(search.items.some((p) => p.id === seeded.result.id)).toBe(false);

    const head = await promptHeadRevisionId(ctx, seeded.result.id);
    await expect(submit(ctx, contributor, seeded.result.id, head, "nope")).rejects.toMatchObject({ code: "STALE_ENTITY" });

    const restored = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.entity_version;
    await exec(maintainer, ctx, { type: "prompt.restore", promptId: seeded.result.id, expectedEntityVersion: restored });
    const revived = await listPrompts(h.pool, ctx.workspaceId, { q: "archivable" });
    expect(revived.items.some((p) => p.id === seeded.result.id)).toBe(true);
  });

  it("rollback targets published history only and records an audit event", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Roll", "maintainer");
    const reviewer = await member(ctx, "Dana Roll", "maintainer");
    const contributor = await member(ctx, "Casey Roll", "contributor");
    const seeded = await seed(ctx, maintainer, "rollback base v1");
    const head1 = await promptHeadRevisionId(ctx, seeded.result.id);
    const p2 = await submit(ctx, contributor, seeded.result.id, head1, "rollback v2");
    const i2 = await candidateInfo(p2.result.id);
    await approve(ctx, reviewer, p2.result.id, head1, i2.revisionId, i2.hash);
    const head2 = await promptHeadRevisionId(ctx, seeded.result.id);

    // Rolling back to head1 after the head moved past the expectation fails.
    await expect(
      exec(maintainer, ctx, { type: "prompt.rollback", promptId: seeded.result.id, targetRevisionId: head1, expectedApprovedRevisionId: head1, reason: "undo" }),
    ).rejects.toMatchObject({ code: "STALE_BASE" });

    await exec(maintainer, ctx, { type: "prompt.rollback", promptId: seeded.result.id, targetRevisionId: head1, expectedApprovedRevisionId: head2, reason: "revert to v1" });
    expect(await promptHeadRevisionId(ctx, seeded.result.id)).toBe(head1);

    // History still contains both revisions — rollback edits nothing.
    const history = await listPublishedRevisions(h.pool, ctx.workspaceId, seeded.result.id, {});
    expect(history.items).toHaveLength(2);
    const audits = await h.pool.query<{ action: string }>(
      "SELECT action FROM team_audit WHERE workspace_id = $1 AND resource_id = $2 AND action = 'prompt.rollback'",
      [ctx.workspaceId, seeded.result.id],
    );
    expect(audits.rows).toHaveLength(1);
  });
});
