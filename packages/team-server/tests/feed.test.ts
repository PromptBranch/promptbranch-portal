import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { readChanges, feedBounds } from "../src/sync/changes";
import { sweepExpiredSyncState } from "../src/sync/retention";

// P5 feed (plan review focus #3): sequences allocate under the workspace
// lock so commit order and sequence order never disagree; grouped events,
// tombstones, cursor rules and retention floor.

let h: TeamTestHarness;
const principals = new Map<string, HumanPrincipal>();

async function as(name: string): Promise<HumanPrincipal> {
  if (!principals.has(name)) principals.set(name, (await h.asUser(name)).principal);
  return principals.get(name)!;
}

interface Ctx {
  workspaceId: string;
  epoch: string;
  generation: string;
  owner: HumanPrincipal;
}

async function workspace(owner = "Alice Feed"): Promise<Ctx> {
  const ownerPrincipal = await as(owner);
  const created = await h.service.createWorkspace(ownerPrincipal, { commandId: randomUUID(), name: `Feed ${randomUUID().slice(0, 6)}` });
  return { workspaceId: created.workspace.id, epoch: created.workspace.serverEpoch, generation: created.workspace.membershipGeneration, owner: ownerPrincipal };
}

async function member(ctx: Ctx, name: string, role: "maintainer" | "contributor" | "viewer"): Promise<HumanPrincipal> {
  const principal = await as(name);
  const row = await h.pool.query(
    `INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, $3, gen_random_uuid())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL
     RETURNING (SELECT generation FROM team_memberships m WHERE m.workspace_id = $1 AND m.user_id = $2)`,
    [ctx.workspaceId, principal.userId, role],
  );
  void row;
  return principal;
}

async function exec(principal: HumanPrincipal, ctx: Ctx, operation: Record<string, unknown>) {
  const generation = (
    await h.pool.query<{ generation: string }>(
      "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ctx.workspaceId, principal.userId],
    )
  ).rows[0]!.generation;
  return h.service.execute(principal, ctx.workspaceId, ctx.epoch, { commandId: randomUUID(), membershipGeneration: generation, operation });
}

async function headOf(ctx: Ctx, promptId: string): Promise<string> {
  return (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [promptId])).rows[0]!.approved_revision_id!;
}

async function feed(ctx: Ctx, after = "0") {
  const bounds = await feedBounds(h.pool, ctx.workspaceId);
  return readChanges(h.pool, { workspaceId: ctx.workspaceId, after, minRetainedSeq: bounds.minRetainedSeq, currentMaxSeq: bounds.currentMaxSeq });
}

beforeAll(async () => {
  h = await createTeamTestHarness();
});
afterAll(async () => {
  await h.close();
});

describe("feed events", () => {
  it("groups approval into one revision+head event and keeps candidate text out until then", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Group", "maintainer");
    const contributor = await member(ctx, "Casey Group", "contributor");

    const seed = await exec(ctx.owner, ctx, { type: "prompt.create", title: "Feed prompt", description: "", content: "approved body", tagIds: [], collectionIds: [], changeNote: "" });
    expect(seed.catalogSeq).not.toBe("0");
    const seedEvent = (await feed(ctx)).changes.at(-1)!;
    expect(seedEvent.records.map((r) => r.entity).sort()).toEqual(["prompt", "revision"]);

    const submit = await exec(contributor, ctx, {
      type: "proposal.submit",
      promptId: seed.result.id,
      baseRevisionId: await headOf(ctx, seed.result.id),
      content: "candidate-only-marker-qwerty",
      rationale: "r",
      supersedesProposalId: null,
    });
    expect(submit.catalogSeq).toBe("0"); // submissions emit nothing
    const beforeApproval = JSON.stringify((await feed(ctx)).changes);
    expect(beforeApproval).not.toContain("candidate-only-marker-qwerty");

    const candidate = (await h.pool.query<{ candidate_revision_id: string; entity_version: number }>(
      "SELECT candidate_revision_id, entity_version FROM team_proposals WHERE id = $1",
      [submit.result.id],
    )).rows[0]!;
    const hash = (await h.pool.query<{ content_hash: string }>("SELECT content_hash FROM team_revisions WHERE id = $1", [candidate.candidate_revision_id])).rows[0]!.content_hash;
    const approve = await exec(maintainer, ctx, {
      type: "proposal.review",
      proposalId: submit.result.id,
      expectedEntityVersion: candidate.entity_version,
      candidateRevisionId: candidate.candidate_revision_id,
      candidateContentHash: hash,
      expectedApprovedRevisionId: await headOf(ctx, seed.result.id),
      decision: "approve",
      comment: "",
    });
    expect(approve.catalogSeq).not.toBe("0");

    const events = (await feed(ctx)).changes;
    const approval = events.find((e) => e.seq === approve.catalogSeq)!;
    // One grouped event: the new revision AND the moved head together.
    expect(approval.records.map((r) => r.entity).sort()).toEqual(["prompt", "revision"]);
    expect(JSON.stringify(approval)).toContain("candidate-only-marker-qwerty");
    // Duplicate delivery is a client-side no-op; the server payload is
    // byte-stable across reads.
    expect(JSON.stringify((await feed(ctx)).changes.find((e) => e.seq === approve.catalogSeq))).toBe(JSON.stringify(approval));
  });

  it("tag deletion emits a compact tombstone, not per-prompt events", async () => {
    const ctx = await workspace();
    const tag = await exec(ctx.owner, ctx, { type: "tag.create", name: "Tombstone" });
    const seeded = await exec(ctx.owner, ctx, { type: "prompt.create", title: "Tagged", description: "", content: "c", tagIds: [tag.result.id], collectionIds: [], changeNote: "" });
    const version = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_tags WHERE id = $1", [tag.result.id])).rows[0]!.entity_version;
    const del = await exec(ctx.owner, ctx, { type: "tag.delete", id: tag.result.id, expectedEntityVersion: version });
    expect(del.catalogSeq).not.toBe("0");

    const tomb = (await feed(ctx)).changes.find((e) => e.seq === del.catalogSeq)!;
    expect(tomb.records).toHaveLength(0);
    expect(tomb.tombstones).toEqual([{ entity: "tag", id: tag.result.id }]);
    void seeded;
  });

  it("comments, membership and invitation commands emit no catalogue events", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "member.role", userId: (await member(ctx, "Silent Member", "viewer")).userId, role: "viewer", expectedEntityVersion: 1 });
    const bounds = await feedBounds(h.pool, ctx.workspaceId);
    expect(bounds.currentMaxSeq).toBe(0); // nothing catalogue-visible happened
    expect((await feed(ctx, "0")).changes).toHaveLength(0);
  });
});

describe("commit-order invariant (two connections)", () => {
  it("an uncommitted sequence blocks later allocations and stays invisible until commit", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Warmup" }); // seq 1 committed

    // Connection A: allocate a sequence and insert its event, then PAUSE
    // before commit while holding the workspace row lock.
    const a = h.raw;
    await a.query("BEGIN");
    const allocated = await a.query<{ seq: string }>(
      `UPDATE team_workspaces SET next_catalog_seq = next_catalog_seq + 1 WHERE id = $1 RETURNING (next_catalog_seq - 1)::text AS seq`,
      [ctx.workspaceId],
    );
    const pausedSeq = allocated.rows[0]!.seq;
    await a.query("INSERT INTO team_changes (workspace_id, seq, payload_json) VALUES ($1, $2, $3)", [
      ctx.workspaceId,
      pausedSeq,
      JSON.stringify({ records: [{ entity: "tag", value: { id: "paused", workspaceId: ctx.workspaceId, name: "paused", entityVersion: 1 } }], tombstones: [] }),
    ]);

    // Connection B: a real catalogue command queues on the workspace lock.
    const pending = exec(ctx.owner, ctx, { type: "tag.create", name: "After Pause" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // While A is uncommitted: B has not committed, and no reader sees the paused seq.
    const during = await feed(ctx);
    expect(during.changes.some((e) => e.seq === pausedSeq)).toBe(false);
    expect(Number((await feedBounds(h.pool, ctx.workspaceId)).currentMaxSeq)).toBeLessThan(Number(pausedSeq));

    await a.query("COMMIT"); // release the paused event
    const bReceipt = await pending;
    expect(Number(bReceipt.catalogSeq)).toBe(Number(pausedSeq) + 1); // strictly after

    const events = (await feed(ctx)).changes.map((e) => e.seq);
    expect(events.indexOf(pausedSeq)).toBeLessThan(events.indexOf(bReceipt.catalogSeq));
    expect(events).toEqual([...events].sort((x, y) => Number(x) - Number(y)));
  });
});

describe("cursors and retention", () => {
  it("rejects future and malformed cursors; empty feed echoes the cursor", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Cursor" });
    const bounds = await feedBounds(h.pool, ctx.workspaceId);
    await expect(feed(ctx, String(bounds.currentMaxSeq + 5))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(feed(ctx, "not-a-number")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const empty = await feed(ctx, String(bounds.currentMaxSeq));
    expect(empty.changes).toHaveLength(0);
    expect(empty.nextCursor).toBe(String(bounds.currentMaxSeq));
    expect(empty.hasMore).toBe(false);
  });

  it("pruning advances the retained floor transactionally (CURSOR_EXPIRED below it)", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Old1" });
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Old2" });
    await exec(ctx.owner, ctx, { type: "tag.create", name: "New" });
    // Backdate the first two events beyond the 30-day window and sweep.
    await h.pool.query(
      `UPDATE team_changes SET created_at = now() - interval '31 days' WHERE workspace_id = $1 AND seq <= 2`,
      [ctx.workspaceId],
    );
    const sweep = await sweepExpiredSyncState(h.pool);
    expect(sweep.prunedChanges).toBe(2);

    await expect(feed(ctx, "1")).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(feed(ctx, "0")).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    const resumed = await feed(ctx, "2");
    expect(resumed.changes.map((e) => e.seq)).toEqual(["3"]);
    // A second sweep with nothing due is a no-op and never moves the floor.
    await sweepExpiredSyncState(h.pool);
    await expect(feed(ctx, "2")).resolves.toBeTruthy();
  });
});
