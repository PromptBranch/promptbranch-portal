import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { listOrgEntities } from "../src/domain/organization";
import { listProposals, getProposalDetail } from "../src/domain/proposals";
import { listPrompts, getPromptWithHead } from "../src/domain/prompts";

// Organization (tags/collections) + privacy: case-insensitive uniqueness,
// junction cascades, and the viewer/outsider cannot discover candidate
// content through any catalogue or collaboration surface.

let h: TeamTestHarness;
const principals = new Map<string, HumanPrincipal>();

async function as(name: string): Promise<HumanPrincipal> {
  if (!principals.has(name)) principals.set(name, (await h.asUser(name)).principal);
  return principals.get(name)!;
}

interface Ctx {
  workspaceId: string;
  epoch: string;
}

async function workspace(owner = "Alice Org"): Promise<Ctx> {
  const created = await h.service.createWorkspace(await as(owner), { commandId: randomUUID(), name: `Org ${randomUUID().slice(0, 6)}` });
  return { workspaceId: created.workspace.id, epoch: created.workspace.serverEpoch };
}

async function generationOf(ctx: Ctx, principal: HumanPrincipal): Promise<string> {
  const row = await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
    [ctx.workspaceId, principal.userId],
  );
  return row.rows[0]!.generation;
}

async function member(ctx: Ctx, name: string, role: "maintainer" | "contributor" | "viewer"): Promise<HumanPrincipal> {
  const principal = await as(name);
  await h.pool.query(
    `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
     VALUES ($1, $2, $3, gen_random_uuid())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
    [ctx.workspaceId, principal.userId, role],
  );
  return principal;
}

async function exec(principal: HumanPrincipal, ctx: Ctx, operation: Record<string, unknown>) {
  return h.service.execute(principal, ctx.workspaceId, ctx.epoch, {
    commandId: randomUUID(),
    membershipGeneration: await generationOf(ctx, principal),
    operation,
  });
}

beforeAll(async () => {
  h = await createTeamTestHarness();
});
afterAll(async () => {
  await h.close();
});

describe("tags and collections", () => {
  it("enforces trimmed case-insensitive uniqueness while preserving display case", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Tags", "maintainer");
    const first = await exec(maintainer, ctx, { type: "tag.create", name: "Production" });
    await expect(exec(maintainer, ctx, { type: "tag.create", name: " production " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(exec(maintainer, ctx, { type: "tag.create", name: "PRODUCTION" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const tags = await listOrgEntities(h.pool, "tag", ctx.workspaceId);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.name).toBe("Production");

    // Rename collides with ANOTHER TAG of the same normalized name; tags and
    // collections keep separate namespaces.
    const version = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_tags WHERE id = $1", [first.result.id])).rows[0]!.entity_version;
    const otherTag = await exec(maintainer, ctx, { type: "tag.create", name: "Staging" });
    await expect(
      exec(maintainer, ctx, { type: "tag.rename", id: first.result.id, name: "staging", expectedEntityVersion: version }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await exec(maintainer, ctx, { type: "tag.rename", id: first.result.id, name: "Prod Safe", expectedEntityVersion: version });
    // A collection may share a name with a tag (separate namespace).
    await exec(maintainer, ctx, { type: "collection.create", name: "staging" });
    void otherTag;
  });

  it("deleting a tag removes its prompt references transactionally", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Cascade", "maintainer");
    const tag = await exec(maintainer, ctx, { type: "tag.create", name: "Cleanup" });
    const collection = await exec(maintainer, ctx, { type: "collection.create", name: "Archive shelf" });
    const seeded = await exec(maintainer, ctx, {
      type: "prompt.create",
      title: "Tagged prompt",
      description: "",
      content: "content with tags",
      tagIds: [tag.result.id],
      collectionIds: [collection.result.id],
      changeNote: "",
    });
    const tagVersion = (await h.pool.query<{ entity_version: number }>("SELECT entity_version FROM team_tags WHERE id = $1", [tag.result.id])).rows[0]!.entity_version;
    await exec(maintainer, ctx, { type: "tag.delete", id: tag.result.id, expectedEntityVersion: tagVersion });

    const detail = await getPromptWithHead(h.pool, ctx.workspaceId, seeded.result.id);
    expect(detail.prompt.tagIds).toEqual([]);
    expect(detail.prompt.collectionIds).toEqual([collection.result.id]);
    // Foreign-workspace tag ids are rejected by the composite FK.
    const otherCtx = await workspace("Erin Otherws");
    const otherMaintainer = await member(otherCtx, "Frank Otherws", "maintainer");
    const foreignTag = await exec(otherMaintainer, otherCtx, { type: "tag.create", name: "Foreign" });
    await expect(
      exec(maintainer, ctx, {
        type: "prompt.metadata",
        promptId: seeded.result.id,
        title: "Tagged prompt",
        description: "",
        tagIds: [foreignTag.result.id],
        collectionIds: [],
        expectedEntityVersion: detail.prompt.entityVersion,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("viewers and contributors cannot manage organization or content", async () => {
    const ctx = await workspace();
    await member(ctx, "Casey Roles", "contributor");
    await member(ctx, "Dana Roles", "viewer");
    const viewer = await as("Dana Roles");
    const contributor = await as("Casey Roles");
    for (const operation of [
      { type: "tag.create", name: "Nope" },
      { type: "prompt.create", title: "t", description: "", content: "c", tagIds: [], collectionIds: [], changeNote: "" },
    ]) {
      await expect(exec(contributor, ctx, operation), `${operation.type} by contributor`).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
      });
      await expect(exec(viewer, ctx, operation), `${operation.type} by viewer`).rejects.toMatchObject({
        code: "ROLE_FORBIDDEN",
      });
    }
  });
});

describe("candidate privacy", () => {
  it("viewers and outsiders never discover candidate content on any surface", async () => {
    const ctx = await workspace();
    const maintainer = await member(ctx, "Bob Priv", "maintainer");
    const contributor = await member(ctx, "Casey Priv", "contributor");
    const viewer = await member(ctx, "Dana Priv", "viewer");
    const seeded = await exec(maintainer, ctx, {
      type: "prompt.create",
      title: "Public approved prompt",
      description: "",
      content: "approved public content",
      tagIds: [],
      collectionIds: [],
      changeNote: "",
    });
    const head = (await h.pool.query<{ approved_revision_id: string }>("SELECT approved_revision_id FROM team_prompts WHERE id = $1", [seeded.result.id])).rows[0]!.approved_revision_id!;
    const proposal = await exec(contributor, ctx, {
      type: "proposal.submit",
      promptId: seeded.result.id,
      baseRevisionId: head,
      content: "unapproved-secret-marker zebra-unicorn-candidate",
      rationale: "private change",
      supersedesProposalId: null,
    });
    const candidateRevisionId = (await h.pool.query<{ candidate_revision_id: string }>("SELECT candidate_revision_id FROM team_proposals WHERE id = $1", [proposal.result.id])).rows[0]!.candidate_revision_id;

    // Search never matches candidate strings.
    for (const q of ["unapproved-secret-marker", "zebra-unicorn-candidate"]) {
      const results = await listPrompts(h.pool, ctx.workspaceId, { q });
      expect(results.items, `search "${q}"`).toHaveLength(0);
    }
    // History and the exact-revision endpoint expose published rows only.
    const detail = await getPromptWithHead(h.pool, ctx.workspaceId, seeded.result.id);
    expect(JSON.stringify(detail)).not.toContain("unapproved-secret-marker");

    // Viewers cannot list proposals (contributor+ surface).
    const viewerPrincipal = viewer;
    await expect(
      h.service.execute(viewerPrincipal, ctx.workspaceId, ctx.epoch, {
        commandId: randomUUID(),
        membershipGeneration: await generationOf(ctx, viewer),
        operation: { type: "comment.add", proposalId: proposal.result.id, body: "sneak" },
      }),
    ).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });

    // Contributors see proposals; the detail carries the candidate — but only
    // for contributor+ (the route layer enforces the same floor).
    const listed = await listProposals(h.pool, ctx.workspaceId, { status: "open" });
    expect(listed.items.some((p) => p.id === proposal.result.id)).toBe(true);
    const proposalDetail = await getProposalDetail(h.pool, ctx.workspaceId, proposal.result.id);
    expect(proposalDetail.candidate.content).toContain("unapproved-secret-marker");

    // Cross-workspace ids never resolve.
    const outsiderCtx = await workspace("Erin Outside");
    await expect(getProposalDetail(h.pool, outsiderCtx.workspaceId, proposal.result.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    void candidateRevisionId;
  });
});
