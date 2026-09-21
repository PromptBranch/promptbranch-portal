import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { consumeRateBucket, INVITATIONS_PER_HOUR } from "../src/domain/rate";
import { sweepExpiredSyncState } from "../src/sync/retention";
import { startBootstrap, readBootstrapPage } from "../src/sync/bootstrap";
import { CursorSigner } from "../src/sync/cursors";
import { isTeamError } from "../src/errors";

// P8 abuse controls: the shared Postgres rate buckets (contract C8), the
// invitation quota in dispatch, retention of expired buckets, and the
// one-active-bootstrap cap per principal per workspace.

let h: TeamTestHarness;
let signer: CursorSigner;

beforeAll(async () => {
  h = await createTeamTestHarness();
  signer = new CursorSigner(Buffer.from("rate-limit-test-cursor-key"));
});
afterAll(async () => {
  await h.close();
});

describe("consumeRateBucket", () => {
  it("allows up to the limit and rejects the next call in the same window", async () => {
    const key = `unit:${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await expect(consumeRateBucket(h.pool, key, 3, 60_000)).resolves.toBeUndefined();
    }
    await expect(consumeRateBucket(h.pool, key, 3, 60_000)).rejects.toSatisfy(
      (error: unknown) => isTeamError(error) && error.code === "RATE_LIMITED" && error.httpStatus === 429,
    );
  });

  it("starts a fresh window after the previous one expires", async () => {
    const key = `unit:${randomUUID()}`;
    await expect(consumeRateBucket(h.pool, key, 1, 60_000)).resolves.toBeUndefined();
    await expect(consumeRateBucket(h.pool, key, 1, 60_000)).rejects.toSatisfy((error: unknown) =>
      isTeamError(error) && error.code === "RATE_LIMITED",
    );
    // Age the row out (deterministic stand-in for the window elapsing; real
    // 40ms windows would make the test racy against clock boundaries).
    await h.pool.query("UPDATE team_rate_buckets SET expires_at = now() - interval '1 second' WHERE bucket_key = $1", [key]);
    await expect(consumeRateBucket(h.pool, key, 1, 60_000)).resolves.toBeUndefined();
  });

  it("never lets concurrent callers increment past the limit (atomic upsert)", async () => {
    const key = `unit:${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => consumeRateBucket(h.pool, key, 4, 60_000)),
    );
    // Counts returned by the UPSERT are 1..12 in commit order regardless of
    // interleaving: exactly 4 fulfill, 8 reject — no read-modify-write race.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(results.filter((r) => r.status === "rejected" && isTeamError(r.reason) && r.reason.code === "RATE_LIMITED")).toHaveLength(8);
  });

  it("retention sweeps expired buckets and keeps live ones", async () => {
    const liveKey = `unit:${randomUUID()}`;
    await consumeRateBucket(h.pool, liveKey, 5, 60_000);
    // A bucket whose window already elapsed is exactly what the sweep owns.
    const stale = await h.pool.query(
      "INSERT INTO team_rate_buckets (bucket_key, window_start, count, expires_at) VALUES ($1, now() - interval '2 hours', 9, now() - interval '1 hour') RETURNING bucket_key",
      [`unit:${randomUUID()}`],
    );
    const sweep = await sweepExpiredSyncState(h.pool);
    expect(sweep.expiredRateBuckets).toBeGreaterThanOrEqual(1);
    const surviving = await h.pool.query("SELECT 1 FROM team_rate_buckets WHERE bucket_key = $1", [stale.rows[0]!.bucket_key]);
    expect(surviving.rowCount).toBe(0);
    const kept = await h.pool.query("SELECT count FROM team_rate_buckets WHERE bucket_key = $1", [liveKey]);
    expect(kept.rows[0]!.count).toBe(1);
  });
});

describe("invitation quota", () => {
  it("caps invitation.create at 20 per workspace per hour without touching other operations", async () => {
    const owner = (await h.asUser("Quota Owner")).principal;
    const created = await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Quota ${randomUUID().slice(0, 6)}` });
    const ws = created.workspace;
    const generation = async () =>
      (await h.pool.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [ws.id, owner.userId],
      )).rows[0]!.generation;

    for (let i = 0; i < INVITATIONS_PER_HOUR; i++) {
      await h.service.execute(owner, ws.id, ws.serverEpoch, {
        commandId: randomUUID(),
        membershipGeneration: await generation(),
        operation: { type: "invitation.create", email: `quota-${i}-${randomUUID().slice(0, 8)}@example.test`, role: "viewer" },
      });
    }
    const over = await h.service
      .execute(owner, ws.id, ws.serverEpoch, {
        commandId: randomUUID(),
        membershipGeneration: await generation(),
        operation: { type: "invitation.create", email: `quota-over-${randomUUID().slice(0, 8)}@example.test`, role: "viewer" },
      })
      .catch((error: unknown) => error);
    expect(isTeamError(over) && over.code === "RATE_LIMITED").toBe(true);

    // The workspace-scoped quota never bleeds into other write kinds.
    const workspaceNow = await h.pool.query<{ entity_version: number }>(
      "SELECT entity_version FROM team_workspaces WHERE id = $1",
      [ws.id],
    );
    const renamed = await h.service.execute(owner, ws.id, ws.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: await generation(),
      operation: { type: "workspace.rename", name: "Quota ws renamed", expectedEntityVersion: workspaceNow.rows[0]!.entity_version },
    });
    expect(renamed.result.kind).toBe("workspace");
  });
});

describe("bootstrap single-active cap", () => {
  it("supersedes the prior snapshot when the generation changes, leaving exactly one active", async () => {
    const owner: HumanPrincipal = (await h.asUser("Cap Owner")).principal;
    const created = await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Cap ${randomUUID().slice(0, 6)}` });
    const ws = created.workspace;
    const generationOf = async () =>
      (await h.pool.query<{ generation: string }>(
        "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [ws.id, owner.userId],
      )).rows[0]!.generation;

    const first = await startBootstrap(h.pool, {
      principal: owner,
      workspaceId: ws.id,
      membershipGeneration: await generationOf(),
      serverEpoch: ws.serverEpoch,
      currentEpoch: ws.serverEpoch,
      currentGeneration: await generationOf(),
    });
    expect(first.created).toBe(true);

    // A membership event rotates the generation (simulated directly — the
    // command path to the same state is covered by the membership suites).
    const rotated = randomUUID();
    await h.pool.query("UPDATE team_memberships SET generation = $1 WHERE workspace_id = $2 AND user_id = $3", [rotated, ws.id, owner.userId]);

    const second = await startBootstrap(h.pool, {
      principal: owner,
      workspaceId: ws.id,
      membershipGeneration: rotated,
      serverEpoch: ws.serverEpoch,
      currentEpoch: ws.serverEpoch,
      currentGeneration: rotated,
    });
    expect(second.created).toBe(true);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const active = await h.pool.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM team_bootstraps WHERE workspace_id = $1",
      [ws.id],
    );
    expect(active.rows.map((r) => r.snapshot_id)).toEqual([second.snapshotId]);

    // The superseded snapshot no longer serves pages to its old holder.
    await expect(
      readBootstrapPage(h.pool, {
        principal: owner,
        workspaceId: ws.id,
        snapshotId: first.snapshotId,
        signer,
        currentEpoch: ws.serverEpoch,
        currentGeneration: rotated,
      }),
    ).rejects.toSatisfy((error: unknown) => isTeamError(error) && error.code === "SNAPSHOT_EXPIRED");
  });
});
