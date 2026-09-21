import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { startBootstrap, readBootstrapPage } from "../src/sync/bootstrap";
import { CursorSigner } from "../src/sync/cursors";

// P5 bootstrap (contract §C7): materialized under the workspace lock in
// repeatable read, highWater from the same state, reuse-until-expiry,
// signed paging tokens, access rechecked on every page, candidates absent.

let h: TeamTestHarness;
let signer: CursorSigner;
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

async function workspace(owner = "Alice Boot"): Promise<Ctx> {
  const ownerPrincipal = await as(owner);
  const created = await h.service.createWorkspace(ownerPrincipal, { commandId: randomUUID(), name: `Boot ${randomUUID().slice(0, 6)}` });
  return { workspaceId: created.workspace.id, epoch: created.workspace.serverEpoch, generation: created.workspace.membershipGeneration, owner: ownerPrincipal };
}

async function exec(principal: HumanPrincipal, ctx: Ctx, operation: Record<string, unknown>) {
  const generation = (await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [ctx.workspaceId, principal.userId],
  )).rows[0]!.generation;
  return h.service.execute(principal, ctx.workspaceId, ctx.epoch, { commandId: randomUUID(), membershipGeneration: generation, operation });
}

function boot(ctx: Ctx, principal: HumanPrincipal, overrides: Partial<{ membershipGeneration: string; serverEpoch: string }> = {}) {
  return startBootstrap(h.pool, {
    principal,
    workspaceId: ctx.workspaceId,
    membershipGeneration: overrides.membershipGeneration ?? ctx.generation,
    serverEpoch: overrides.serverEpoch ?? ctx.epoch,
    currentEpoch: ctx.epoch,
    currentGeneration: overrides.membershipGeneration === undefined ? ctx.generation : ctx.generation,
  });
}

beforeAll(async () => {
  h = await createTeamTestHarness();
  signer = new CursorSigner(Buffer.from("bootstrap-test-cursor-key"));
});
afterAll(async () => {
  await h.close();
});

describe("bootstrap lifecycle", () => {
  it("materializes prompts, published revisions and tags with a consistent highWater", async () => {
    const ctx = await workspace();
    const tag = await exec(ctx.owner, ctx, { type: "tag.create", name: "BootTag" });
    const seeded = await exec(ctx.owner, ctx, { type: "prompt.create", title: "Boot prompt", description: "", content: "approved boot body", tagIds: [tag.result.id], collectionIds: [], changeNote: "" });
    // A candidate that must NOT appear in the snapshot.
    const head = (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.approved_revision_id;
    const contributor = (await h.asUser("Casey Boot")).principal;
    await h.pool.query(`INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'contributor', gen_random_uuid())`, [ctx.workspaceId, contributor.userId]);
    await exec(contributor, ctx, { type: "proposal.submit", promptId: seeded.result.id, baseRevisionId: head, content: "boot-candidate-marker", rationale: "r", supersedesProposalId: null });

    const start = await boot(ctx, ctx.owner);
    expect(start.created).toBe(true);
    expect(Number(start.highWater)).toBe(2); // tag.create then prompt.create

    const page = await readBootstrapPage(h.pool, {
      principal: ctx.owner,
      workspaceId: ctx.workspaceId,
      snapshotId: start.snapshotId,
      signer,
      currentEpoch: ctx.epoch,
      currentGeneration: ctx.generation,
    });
    const entities = page.records.map((r) => r.entity).sort();
    expect(entities).toEqual(["prompt", "revision", "tag"]);
    const blob = JSON.stringify(page);
    expect(blob).toContain("approved boot body");
    expect(blob).not.toContain("boot-candidate-marker");
    expect(page.highWater).toBe(start.highWater);
    expect(page.nextPageToken).toBeNull();
  });

  it("reuses a valid snapshot and replaces an expired one", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Reuse" });

    const first = await boot(ctx, ctx.owner);
    expect(first.created).toBe(true);
    const second = await boot(ctx, ctx.owner);
    expect(second.created).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);

    await h.pool.query("UPDATE team_bootstraps SET expires_at = now() - interval '1 second' WHERE snapshot_id = $1", [first.snapshotId]);
    await expect(
      readBootstrapPage(h.pool, { principal: ctx.owner, workspaceId: ctx.workspaceId, snapshotId: first.snapshotId, signer, currentEpoch: ctx.epoch, currentGeneration: ctx.generation }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });

    const third = await boot(ctx, ctx.owner);
    expect(third.created).toBe(true);
    expect(third.snapshotId).not.toBe(first.snapshotId);
    // The expired snapshot's rows are gone (replaced, not leaked).
    const stale = await h.pool.query("SELECT count(*)::int AS n FROM team_bootstrap_rows WHERE snapshot_id = $1", [first.snapshotId]);
    expect(stale.rows[0].n).toBe(0);
  });

  it("pages with signed tokens, rejects tampering and foreign principals", async () => {
    const ctx = await workspace();
    for (let i = 0; i < 5; i++) {
      await exec(ctx.owner, ctx, { type: "tag.create", name: `Page ${i}` });
    }
    const start = await boot(ctx, ctx.owner);
    const page1 = await readBootstrapPage(h.pool, {
      principal: ctx.owner,
      workspaceId: ctx.workspaceId,
      snapshotId: start.snapshotId,
      signer,
      currentEpoch: ctx.epoch,
      currentGeneration: ctx.generation,
      limit: 3,
    });
    expect(page1.records).toHaveLength(3);
    expect(page1.nextPageToken).toBeTypeOf("string");

    const page2 = await readBootstrapPage(h.pool, {
      principal: ctx.owner,
      workspaceId: ctx.workspaceId,
      snapshotId: start.snapshotId,
      pageToken: page1.nextPageToken!,
      signer,
      currentEpoch: ctx.epoch,
      currentGeneration: ctx.generation,
      limit: 3,
    });
    expect(page2.records).toHaveLength(2);

    // Tampered token and foreign snapshot principal both fail closed.
    await expect(
      readBootstrapPage(h.pool, { principal: ctx.owner, workspaceId: ctx.workspaceId, snapshotId: start.snapshotId, pageToken: page1.nextPageToken!.slice(0, -3) + "aaa", signer, currentEpoch: ctx.epoch, currentGeneration: ctx.generation }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const stranger = (await h.asUser("Erin Stranger")).principal;
    await expect(
      readBootstrapPage(h.pool, { principal: stranger, workspaceId: ctx.workspaceId, snapshotId: start.snapshotId, signer, currentEpoch: ctx.epoch, currentGeneration: ctx.generation }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
  });

  it("rechecks membership and epoch on every page", async () => {
    const ctx = await workspace();
    await exec(ctx.owner, ctx, { type: "tag.create", name: "Guard" });
    const start = await boot(ctx, ctx.owner);

    // Membership removal between start and page → MEMBERSHIP_CHANGED/403.
    const removedMember = (await h.asUser("Dana Bootpage")).principal;
    await h.pool.query(`INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'viewer', gen_random_uuid())`, [ctx.workspaceId, removedMember.userId]);
    const memberStart = await boot(ctx, removedMember);
    const rotated = (await h.pool.query<{ generation: string }>(
      "UPDATE team_memberships SET removed_at = now(), generation = gen_random_uuid() WHERE workspace_id = $1 AND user_id = $2 RETURNING generation",
      [ctx.workspaceId, removedMember.userId],
    )).rows[0]!.generation;
    // With the CURRENT generation the snapshot's binding no longer matches.
    await expect(
      readBootstrapPage(h.pool, { principal: removedMember, workspaceId: ctx.workspaceId, snapshotId: memberStart.snapshotId, signer, currentEpoch: ctx.epoch, currentGeneration: rotated }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CHANGED" });

    // Epoch drift invalidates even the owner's snapshot.
    await h.pool.query("UPDATE team_workspaces SET server_epoch = gen_random_uuid() WHERE id = $1", [ctx.workspaceId]);
    await expect(
      readBootstrapPage(h.pool, { principal: ctx.owner, workspaceId: ctx.workspaceId, snapshotId: start.snapshotId, signer, currentEpoch: (await h.pool.query<{ server_epoch: string }>("SELECT server_epoch FROM team_workspaces WHERE id = $1", [ctx.workspaceId])).rows[0]!.server_epoch, currentGeneration: ctx.generation }),
    ).rejects.toMatchObject({ code: "SERVER_EPOCH_CHANGED" });
  });
});
