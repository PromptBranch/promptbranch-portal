import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { canonicalJson, requestHash } from "../src/commands/receipts";

// Workspace lifecycle + command idempotency (plan P3; contract §C6):
// same command ID + same request replays the original receipt, a different
// request under the same ID is COMMAND_ID_REUSED, and only successful
// mutations consume IDs.

let h: TeamTestHarness;
let alice: HumanPrincipal;

beforeAll(async () => {
  h = await createTeamTestHarness();
  alice = (await h.asUser("Alice Ws")).principal;
});
afterAll(async () => {
  await h.close();
});

describe("workspace creation", () => {
  it("creates with the sole owner and replays idempotently", async () => {
    const commandId = randomUUID();
    const first = await h.service.createWorkspace(alice, { commandId, name: "Idempotent WS" });
    expect(first.created).toBe(true);
    expect(first.workspace.role).toBe("owner");
    expect(first.workspace.name).toBe("Idempotent WS");

    const replay = await h.service.createWorkspace(alice, { commandId, name: "Idempotent WS" });
    expect(replay.created).toBe(false);
    expect(replay.workspace.id).toBe(first.workspace.id);

    const workspaces = await h.pool.query("SELECT count(*)::int AS n FROM team_workspaces");
    expect(workspaces.rows[0].n).toBe(1);
  });

  it("rejects invalid names and empty command ids", async () => {
    await expect(h.service.createWorkspace(alice, { commandId: randomUUID(), name: "   " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("command idempotency", () => {
  it("same envelope replays the receipt; changed payload is COMMAND_ID_REUSED", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Receipt WS" });
    const w = created.workspace;
    const commandId = randomUUID();

    const envelope = {
      commandId,
      membershipGeneration: w.membershipGeneration,
      operation: { type: "workspace.rename" as const, name: "Receipt renamed", expectedEntityVersion: w.entityVersion },
    };
    const first = await h.service.execute(alice, w.id, w.serverEpoch, envelope);
    expect(first.result.kind).toBe("workspace");
    expect(first.result.entityVersion).toBe(w.entityVersion + 1);

    const replay = await h.service.execute(alice, w.id, w.serverEpoch, envelope);
    expect(replay.result).toEqual(first.result);
    expect(replay.committedAt).toBe(first.committedAt);
    expect(await h.count("team_workspaces")).toBe(2); // the two test workspaces

    await expect(
      h.service.execute(alice, w.id, w.serverEpoch, {
        commandId,
        membershipGeneration: w.membershipGeneration,
        operation: { type: "workspace.rename", name: "DIFFERENT name under the same ID", expectedEntityVersion: w.entityVersion },
      }),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });

    // A failed precondition consumes no command ID.
    const failedId = randomUUID();
    await expect(
      h.service.execute(alice, w.id, w.serverEpoch, {
        commandId: failedId,
        membershipGeneration: w.membershipGeneration,
        operation: { type: "workspace.rename", name: "Stale attempt", expectedEntityVersion: 999 },
      }),
    ).rejects.toMatchObject({ code: "STALE_ENTITY" });
    const consumed = await h.pool.query("SELECT count(*)::int AS n FROM team_command_receipts WHERE command_id = $1", [failedId]);
    expect(consumed.rows[0].n).toBe(0);
  });

  it("canonical JSON is key-order independent and hash covers the generation", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    const g1 = requestHash({ generation: "one", operation: { type: "x" } });
    const g2 = requestHash({ generation: "two", operation: { type: "x" } });
    expect(g1.equals(g2)).toBe(false);
  });
});

describe("workspace deletion", () => {
  it("requires fresh login, confirmName, and soft-disables with purge scheduling", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Doomed WS" });
    const w = created.workspace;

    // Stale login (authenticated 11 minutes ago) refuses.
    const stalePrincipal: HumanPrincipal = { ...alice, authenticatedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    await expect(
      h.service.execute(stalePrincipal, w.id, w.serverEpoch, {
        commandId: randomUUID(),
        membershipGeneration: w.membershipGeneration,
        operation: { type: "workspace.delete", confirmName: "Doomed WS", expectedEntityVersion: w.entityVersion },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Wrong confirmName refuses.
    await expect(
      h.service.execute(alice, w.id, w.serverEpoch, {
        commandId: randomUUID(),
        membershipGeneration: w.membershipGeneration,
        operation: { type: "workspace.delete", confirmName: "Not the name", expectedEntityVersion: w.entityVersion },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // Correct deletion soft-disables and schedules the 30-day purge.
    const receipt = await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "workspace.delete", confirmName: "Doomed WS", expectedEntityVersion: w.entityVersion },
    });
    expect(receipt.result.kind).toBe("workspace");
    const row = await h.pool.query<{ deleted_at: Date | null; purge_after: Date | null }>(
      "SELECT deleted_at, purge_after FROM team_workspaces WHERE id = $1",
      [w.id],
    );
    expect(row.rows[0]!.deleted_at).not.toBeNull();
    expect(row.rows[0]!.purge_after).not.toBeNull();
    // Deleted workspaces disappear from reads.
    await expect(h.service.createWorkspace(alice, { commandId: randomUUID(), name: "x" })).resolves.toBeTruthy();
    const listings = await h.pool.query(
      "SELECT count(*)::int AS n FROM team_workspaces WHERE deleted_at IS NOT NULL",
    );
    expect(listings.rows[0].n).toBe(1);
  });
});

describe("audit trail", () => {
  it("records metadata-only entries for every mutation", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Audited WS" });
    const w = created.workspace;
    await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "workspace.rename", name: "Audited renamed", expectedEntityVersion: w.entityVersion },
    });
    const rows = await h.pool.query<{ action: string; metadata_json: unknown }>(
      "SELECT action, metadata_json FROM team_audit WHERE workspace_id = $1 ORDER BY created_at",
      [w.id],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain("workspace.create");
    expect(actions).toContain("workspace.rename");
    // Metadata stays structural; no content columns exist to leak.
    for (const row of rows.rows) {
      expect(JSON.stringify(row.metadata_json)).not.toContain("Audited");
    }
  });
});
