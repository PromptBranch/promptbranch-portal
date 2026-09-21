import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { getWorkspace } from "../src/domain/workspaces";

// P3 core invariants (plan review focus #1 and #4): the role matrix is
// server-side on every operation; a removed member's replayed commands get
// 403 before any receipt lookup; membership changes rotate the generation;
// re-adds start a new generation that old queued commands cannot use.

const ISSUER = "http://127.0.0.1:48080/realms/promptbranch-dev";
const OPS = [
  "invitation.create",
  "invitation.revoke",
  "member.role",
  "member.remove",
  "workspace.rename",
  "workspace.delete",
] as const;
type OpName = (typeof OPS)[number];

let h: TeamTestHarness;
const users = new Map<string, HumanPrincipal>();

async function user(name: string): Promise<HumanPrincipal> {
  if (!users.has(name)) users.set(name, (await h.asUser(name)).principal);
  return users.get(name)!;
}

beforeAll(async () => {
  h = await createTeamTestHarness();
});
afterAll(async () => {
  await h.close();
});

interface Ctx {
  workspaceId: string;
  epoch: string;
  generation: string;
  entityVersions: Map<string, number>;
}

async function setupWorkspace(owner: string, members: Array<{ name: string; role: string }> = []): Promise<Ctx> {
  const ownerPrincipal = await user(owner);
  const created = await h.service.createWorkspace(ownerPrincipal, { commandId: randomUUID(), name: `Matrix ${owner} ${randomUUID().slice(0, 6)}` });
  const ctx: Ctx = {
    workspaceId: created.workspace.id,
    epoch: created.workspace.serverEpoch,
    generation: created.workspace.membershipGeneration,
    entityVersions: new Map(),
  };
  for (const member of members) {
    const principal = await user(member.name);
    const row = await h.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
       VALUES ($1, $2, $3, $4) RETURNING entity_version`,
      [ctx.workspaceId, principal.userId, member.role, randomUUID()],
    );
    ctx.entityVersions.set(member.name, row.rows[0].entity_version);
  }
  const ownerRow = await h.pool.query<{ entity_version: number }>(
    "SELECT entity_version FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
    [ctx.workspaceId, ownerPrincipal.userId],
  );
  ctx.entityVersions.set(owner, ownerRow.rows[0]!.entity_version);
  return ctx;
}

/** Builds a minimal valid envelope of the given operation type. */
async function envelopeFor(op: OpName, ctx: Ctx, actorName: string): Promise<Record<string, unknown>> {
  const base = { commandId: randomUUID(), membershipGeneration: ctx.generation };
  const ownerRow = await h.pool.query<{ user_id: string }>(
    "SELECT m.user_id FROM team_memberships m JOIN team_users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role = 'owner' AND m.removed_at IS NULL LIMIT 1",
    [ctx.workspaceId],
  );
  const ownerId = ownerRow.rows[0]!.user_id;
  switch (op) {
    case "invitation.create":
      return { ...base, operation: { type: op, email: `invite-${randomUUID().slice(0, 6)}@promptbranch.test`, role: "viewer" } };
    case "invitation.revoke":
      return { ...base, operation: { type: op, invitationId: randomUUID() } };
    case "member.role":
      return { ...base, operation: { type: op, userId: ownerId, role: "owner", expectedEntityVersion: ctx.entityVersions.get(actorName) ?? 1 } };
    case "member.remove":
      return { ...base, operation: { type: op, userId: ownerId, expectedEntityVersion: ctx.entityVersions.get(actorName) ?? 1 } };
    case "workspace.rename":
      return { ...base, operation: { type: op, name: `Renamed ${randomUUID().slice(0, 6)}`, expectedEntityVersion: 1 } };
    case "workspace.delete":
      return { ...base, operation: { type: op, confirmName: "wrong-name-on-purpose", expectedEntityVersion: 1 } };
  }
}

describe("role matrix — every P3 operation is owner-only", () => {
  for (const role of ["viewer", "contributor", "maintainer"] as const) {
    it(`rejects ${role} for every operation with ROLE_FORBIDDEN`, async () => {
      const ctx = await setupWorkspace("Owner Matrix", [{ name: `Matrix ${role}`, role }]);
      const principal = await user(`Matrix ${role}`);
      for (const op of OPS) {
        const envelope = await envelopeFor(op, ctx, `Matrix ${role}`);
        // member.role/member.remove target the owner; that's fine — the
        // actor's own role must still block the command.
        await expect(
          h.service.execute(principal, ctx.workspaceId, ctx.epoch, envelope),
          `${role} × ${op}`,
        ).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
      }
    });
  }

  it("owner executes a representative command successfully", async () => {
    const ctx = await setupWorkspace("Owner Works");
    const owner = await user("Owner Works");
    const envelope = await envelopeFor("workspace.rename", ctx, "Owner Works");
    const receipt = await h.service.execute(owner, ctx.workspaceId, ctx.epoch, envelope);
    expect(receipt.result.kind).toBe("workspace");
    expect(receipt.catalogSeq).toBe("0");
  });
});

describe("membership changes and command replay", () => {
  it("a removed member's replayed command is rejected before any receipt data", async () => {
    const ctx = await setupWorkspace("Alice Replay", [{ name: "Bob Replay", role: "maintainer" }]);
    const alice = await user("Alice Replay");
    const bob = await user("Bob Replay");

    // Give Bob ownership for this test, then run his command with HIS
    // membership generation (generations are per-member).
    await h.pool.query(
      "UPDATE team_memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
      [ctx.workspaceId, bob.userId],
    );
    const bobGeneration = (await h.pool.query<{ generation: string }>(
      "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
      [ctx.workspaceId, bob.userId],
    )).rows[0]!.generation;
    const bobEnvelope = {
      commandId: randomUUID(),
      membershipGeneration: bobGeneration,
      operation: { type: "workspace.rename" as const, name: "Before removal", expectedEntityVersion: 1 },
    };
    const receipt = await h.service.execute(bob, ctx.workspaceId, ctx.epoch, bobEnvelope);
    expect(receipt.result.kind).toBe("workspace");

    // Alice removes Bob: generation rotates, receipts and rows still exist.
    const bobRow = await h.pool.query<{ entity_version: number; generation: string }>(
      "SELECT entity_version, generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
      [ctx.workspaceId, bob.userId],
    );
    await h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
      commandId: randomUUID(),
      membershipGeneration: ctx.generation,
      operation: { type: "member.remove", userId: bob.userId, expectedEntityVersion: bobRow.rows[0]!.entity_version },
    });

    // Replay of Bob's successful command: 403, never the stored receipt.
    await expect(
      h.service.execute(bob, ctx.workspaceId, ctx.epoch, bobEnvelope),
    ).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });
  });

  it("membership generation mismatch returns MEMBERSHIP_CHANGED", async () => {
    const ctx = await setupWorkspace("Gen Owner");
    const owner = await user("Gen Owner");
    await expect(
      h.service.execute(owner, ctx.workspaceId, ctx.epoch, {
        commandId: randomUUID(),
        membershipGeneration: randomUUID(), // stale generation
        operation: { type: "workspace.rename", name: "Nope", expectedEntityVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CHANGED" });
  });

  it("server epoch mismatch returns SERVER_EPOCH_CHANGED and a missing header fails validation", async () => {
    const ctx = await setupWorkspace("Epoch Owner");
    const owner = await user("Epoch Owner");
    const envelope = {
      commandId: randomUUID(),
      membershipGeneration: ctx.generation,
      operation: { type: "workspace.rename", name: "Nope", expectedEntityVersion: 1 },
    };
    await expect(h.service.execute(owner, ctx.workspaceId, randomUUID(), envelope)).rejects.toMatchObject({
      code: "SERVER_EPOCH_CHANGED",
    });
    await expect(h.service.execute(owner, ctx.workspaceId, "not-a-uuid", envelope)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("re-add creates a new generation; the old generation's queued command cannot resume", async () => {
    const ctx = await setupWorkspace("Readd Alice", [{ name: "Casey Readd", role: "contributor" }]);
    const alice = await user("Readd Alice");
    const casey = await user("Casey Readd");

    const caseyRow = () =>
      h.pool.query<{ entity_version: number; generation: string; removed_at: Date | null }>(
        "SELECT entity_version, generation, removed_at FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
        [ctx.workspaceId, casey.userId],
      );

    await h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
      commandId: randomUUID(),
      membershipGeneration: ctx.generation,
      operation: { type: "member.remove", userId: casey.userId, expectedEntityVersion: (await caseyRow()).rows[0]!.entity_version },
    });
    const removed = (await caseyRow()).rows[0]!;
    expect(removed.removed_at).not.toBeNull();

    // A queued command from Casey's OLD generation is dead even though Casey
    // is about to return.
    await expect(
      h.service.execute(casey, ctx.workspaceId, ctx.epoch, {
        commandId: randomUUID(),
        membershipGeneration: removed.generation,
        operation: { type: "workspace.rename", name: "Zombie", expectedEntityVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });

    // Re-add via membership upsert with a fresh generation.
    await h.pool.query(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
       VALUES ($1, $2, 'contributor', $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE
         SET removed_at = NULL, generation = EXCLUDED.generation, entity_version = team_memberships.entity_version + 1`,
      [ctx.workspaceId, casey.userId, randomUUID()],
    );
    const readded = (await caseyRow()).rows[0]!;
    expect(readded.generation).not.toBe(removed.generation);
    expect(readded.removed_at).toBeNull();
  });

  it("the last owner cannot be removed or demoted; concurrent owner changes serialize", async () => {
    const ctx = await setupWorkspace("Race Alice", [{ name: "Bob Race", role: "maintainer" }]);
    const alice = await user("Race Alice");
    const bob = await user("Bob Race");

    const row = async (name: string, id: string) =>
      (await h.pool.query<{ entity_version: number }>(
        "SELECT entity_version FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
        [ctx.workspaceId, id],
      )).rows[0]!.entity_version;

    // Sole owner: removal and demotion both refuse.
    await expect(
      h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
        commandId: randomUUID(),
        membershipGeneration: ctx.generation,
        operation: { type: "member.remove", userId: alice.userId, expectedEntityVersion: await row("Alice", alice.userId) },
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
    await expect(
      h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
        commandId: randomUUID(),
        membershipGeneration: ctx.generation,
        operation: { type: "member.role", userId: alice.userId, role: "maintainer", expectedEntityVersion: await row("Alice", alice.userId) },
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });

    // Promote Bob to owner, then two concurrent removals race. The
    // promotion rotated Bob's generation and version, so refresh both.
    await h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
      commandId: randomUUID(),
      membershipGeneration: ctx.generation,
      operation: { type: "member.role", userId: bob.userId, role: "owner", expectedEntityVersion: await row("Bob", bob.userId) },
    });
    const bobFresh = async () =>
      (await h.pool.query<{ entity_version: number; generation: string }>(
        "SELECT entity_version, generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
        [ctx.workspaceId, bob.userId],
      )).rows[0]!;
    const [a, b] = await Promise.allSettled([
      (async () => {
        const fresh = await bobFresh();
        return h.service.execute(alice, ctx.workspaceId, ctx.epoch, {
          commandId: randomUUID(),
          membershipGeneration: ctx.generation,
          operation: { type: "member.remove", userId: bob.userId, expectedEntityVersion: fresh.entity_version },
        });
      })(),
      (async () => {
        const fresh = await bobFresh();
        return h.service.execute(bob, ctx.workspaceId, ctx.epoch, {
          commandId: randomUUID(),
          membershipGeneration: fresh.generation,
          operation: { type: "member.remove", userId: alice.userId, expectedEntityVersion: await row("Alice", alice.userId) },
        });
      })(),
    ]);
    const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code));
    // Exactly one removal commits; the loser observes post-winner reality
    // through any of the stale/forbidden/owner refusals — never a second one.
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "ok")).toHaveLength(1);
    // Whichever transaction lost the race saw the world after the winner:
    // the workspace still has exactly one owner.
    const owners = await h.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM team_memberships WHERE workspace_id = $1 AND role = 'owner' AND removed_at IS NULL",
      [ctx.workspaceId],
    );
    expect(owners.rows[0]!.n).toBe("1");
  });

  it("workspace reads resolve fresh role and generation; foreign workspaces are generic 403", async () => {
    const ctx = await setupWorkspace("Fresh Alice");
    const alice = await user("Fresh Alice");
    const outsider = await user("Erin Foreign");
    const dto = await getWorkspace(h.pool, alice, ctx.workspaceId);
    expect(dto.role).toBe("owner");
    expect(dto.membershipGeneration).toBe(ctx.generation);
    await expect(getWorkspace(h.pool, outsider, ctx.workspaceId)).rejects.toMatchObject({
      code: "WORKSPACE_FORBIDDEN",
    });
    await expect(getWorkspace(h.pool, alice, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
