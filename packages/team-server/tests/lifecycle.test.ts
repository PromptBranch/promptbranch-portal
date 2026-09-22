import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { runPurgeSweep } from "../src/domain/purge";
import { startExport, readExportPage, verifyExportRecord, EXPORTS_PER_HOUR } from "../src/domain/export";
import { enterRecovery, finishRecoveryWithRoster } from "../src/domain/recovery";
import { consumeRateBucket } from "../src/domain/rate";
import { startBootstrap, readChanges } from "../src/index";
import { CursorSigner } from "../src/sync/cursors";
import { isTeamError } from "../src/errors";
import { Sessions } from "../src/auth/sessions";

// P9 lifecycle: workspace purge + audit retention + tombstone reclamation,
// account-deletion anonymization, the owner export stream, and the
// backup-restore recovery window.

let h: TeamTestHarness;
let signer: CursorSigner;

beforeAll(async () => {
  h = await createTeamTestHarness();
  signer = new CursorSigner(Buffer.from("lifecycle-test-cursor-key"));
});
afterAll(async () => {
  await h.close();
});

async function generationOf(workspaceId: string, userId: string): Promise<string> {
  return (await h.pool.query<{ generation: string }>(
    "SELECT generation FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [workspaceId, userId],
  )).rows[0]!.generation;
}

describe("workspace purge lifecycle", () => {
  it("purges soft-deleted workspaces after 30 days, keeps the tombstone and audit, leaves foreign data alone, and is idempotent", async () => {
    const owner = (await h.asUser("Purge Owner")).principal;
    const other = (await h.asUser("Purge Bystander")).principal;
    const created = await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Purge ${randomUUID().slice(0, 6)}` });
    const ws = created.workspace;
    const bystanderWs = (await h.service.createWorkspace(other, { commandId: randomUUID(), name: `Keep ${randomUUID().slice(0, 6)}` })).workspace;
    const seeded = await h.seedPrompt(ws.id);
    const seededRevision = await h.seedRevision(ws.id, seeded.promptId, { authorUserId: owner.userId });
    await h.publishRevision(ws.id, seeded.promptId, seededRevision.revisionId);
    const keptSeeded = await h.seedPrompt(bystanderWs.id);
    const keptRevision = await h.seedRevision(bystanderWs.id, keptSeeded.promptId, { authorUserId: other.userId });
    await h.publishRevision(bystanderWs.id, keptSeeded.promptId, keptRevision.revisionId);

    // Soft delete (the command path) then age past the grace window.
    await h.service.execute(owner, ws.id, ws.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: await generationOf(ws.id, owner.userId),
      operation: { type: "workspace.delete", confirmName: ws.name, expectedEntityVersion: ws.entityVersion },
    });
    await h.pool.query("UPDATE team_workspaces SET purge_after = now() - interval '1 second' WHERE id = $1", [ws.id]);

    const first = await runPurgeSweep(h.pool);
    expect(first.purgedWorkspaces).toBe(1);

    for (const table of ["team_prompts", "team_revisions", "team_memberships", "team_changes", "team_jobs"]) {
      const count = (await h.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1`, [ws.id])).rows[0]!.count;
      expect(count, `${table} purged`).toBe(0);
    }
    // Tombstone and audit survive the content purge.
    expect((await h.pool.query("SELECT 1 FROM team_workspaces WHERE id = $1 AND deleted_at IS NOT NULL AND purge_after IS NULL", [ws.id])).rowCount).toBe(1);
    expect((await h.pool.query("SELECT count(*)::int AS count FROM team_audit WHERE workspace_id = $1", [ws.id])).rows[0]!.count).toBeGreaterThan(0);
    // Foreign workspace untouched.
    expect((await h.pool.query("SELECT count(*)::int AS count FROM team_prompts WHERE workspace_id = $1", [bystanderWs.id])).rows[0]!.count).toBe(1);

    // Idempotent: re-running purges nothing new.
    expect((await runPurgeSweep(h.pool)).purgedWorkspaces).toBe(0);
  });

  it("reclaims the tombstone only after all of its audit has aged out", async () => {
    const owner = (await h.asUser("Reclaim Owner")).principal;
    const ws = (await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Reclaim ${randomUUID().slice(0, 6)}` })).workspace;
    await h.service.execute(owner, ws.id, ws.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: await generationOf(ws.id, owner.userId),
      operation: { type: "workspace.delete", confirmName: ws.name, expectedEntityVersion: ws.entityVersion },
    });
    await h.pool.query("UPDATE team_workspaces SET purge_after = now() - interval '1 second' WHERE id = $1", [ws.id]);
    await runPurgeSweep(h.pool);
    expect((await h.pool.query("SELECT 1 FROM team_workspaces WHERE id = $1", [ws.id])).rowCount).toBe(1);

    // Audit rows are append-only (UPDATE is trigger-blocked), so retention
    // aging is simulated by inserting a row whose created_at is already
    // past the window; the sweep drops it and reclaims the tombstone.
    await h.pool.query("UPDATE team_workspaces SET deleted_at = now() - interval '91 days' WHERE id = $1", [ws.id]);
    // Drop the command-path's recent audit rows (DELETE is allowed; only
    // UPDATE is trigger-blocked) so the only surviving row is already old.
    await h.pool.query("DELETE FROM team_audit WHERE workspace_id = $1", [ws.id]);
    await h.pool.query(
      `INSERT INTO team_audit (workspace_id, actor_user_id, action, resource_type, resource_id, created_at)
       VALUES ($1::uuid, NULL, 'workspace.delete', 'workspace', $1::text, now() - interval '91 days')`,
      [ws.id],
    );
    const sweep = await runPurgeSweep(h.pool);
    expect(sweep.purgedAuditRows).toBeGreaterThan(0);
    expect(sweep.reclaimedTombstones).toBe(1);
    expect((await h.pool.query("SELECT 1 FROM team_workspaces WHERE id = $1", [ws.id])).rowCount).toBe(0);
  });
});

describe("account deletion anonymization", () => {
  it("revokes agent tokens and replaces identity with Former member while actor ids stay", async () => {
    const otherOwner: HumanPrincipal = (await h.asUser("Anon Other")).principal;
    const ws = (await h.service.createWorkspace(otherOwner, { commandId: randomUUID(), name: `Anon ${randomUUID().slice(0, 6)}` })).workspace;
    const member: HumanPrincipal = (await h.asUser("Anon Member")).principal;
    await h.pool.query("INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'contributor', gen_random_uuid())", [ws.id, member.userId]);
    const agent = await h.asAgent("member-agent", member.userId, { workspaceId: ws.id, scopes: ["catalog:read"] });
    void agent;

    await new Sessions(h.pool, h.secretBox).deleteAccount({
      userId: member.userId,
      appSessionId: member.sessionId,
      confirmEmail: h.emailFor("Anon Member"),
      freshWindowMs: 10 * 60_000,
    });

    const userRow = (await h.pool.query<{ display_name: string; verified_email: string }>(
      "SELECT display_name, verified_email FROM team_users WHERE id = $1",
      [member.userId],
    )).rows[0]!;
    expect(userRow.display_name).toBe("Former member");
    expect(userRow.verified_email).toBe(`former+${member.userId}@deleted.invalid`);
    expect((await h.pool.query("SELECT 1 FROM team_agent_tokens WHERE owner_user_id = $1 AND revoked_at IS NULL", [member.userId])).rowCount).toBe(0);
  });
});

describe("owner export", () => {
  it("materializes a verifiable NDJSON snapshot for the owner only, pages it, and enforces the 3/hour quota", async () => {
    const owner: HumanPrincipal = (await h.asUser("Export Owner")).principal;
    const stranger: HumanPrincipal = (await h.asUser("Export Stranger")).principal;
    const ws = (await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Export ${randomUUID().slice(0, 6)}` })).workspace;
    const seeded = await h.seedPrompt(ws.id, { title: "Exported prompt" });
    const seededRevision = await h.seedRevision(ws.id, seeded.promptId, { authorUserId: owner.userId, content: "exported canary body" });
    await h.publishRevision(ws.id, seeded.promptId, seededRevision.revisionId);
    await h.pool.query("INSERT INTO team_tags (workspace_id, name, normalized_name) VALUES ($1, 'Export tag', 'export tag')", [ws.id]);

    await expect(startExport(h.pool, { workspaceId: ws.id, userId: stranger.userId })).rejects.toSatisfy(
      (error: unknown) => isTeamError(error) && error.code === "ROLE_FORBIDDEN",
    );

    const started = await startExport(h.pool, { workspaceId: ws.id, userId: owner.userId });
    expect(started.manifest.counts.prompt).toBe(1);
    expect(started.manifest.counts.revision).toBe(1);
    expect(started.manifest.counts.tag).toBe(1);
    expect(started.manifest.schemaVersion).toBe(1);

    // Walk every page; verify each record's sha256 and the absence of
    // anything secret (invitation tokens, agent secrets, session data).
    const lines: string[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await readExportPage(h.pool, {
        workspaceId: ws.id,
        userId: owner.userId,
        exportId: started.exportId,
        pageToken: token,
        signer,
        limit: 2,
      });
      for (const line of page.records) {
        expect(verifyExportRecord(line), `record verifies: ${line.slice(0, 60)}`).toBe(true);
      }
      lines.push(...page.records);
      if (!page.nextPageToken) break;
      token = page.nextPageToken;
    }
    expect(lines.length).toBe(Object.values(started.manifest.counts).reduce((a, b) => a + b, 0));
    const all = lines.join("\n");
    // The revision record carries the canary content.
    expect(all).toContain("exported canary body");
    expect(all).not.toContain("token_hash");
    expect(all).not.toContain("pbt_");
    expect(all).not.toContain("payload_encrypted");

    // A fresh start supersedes the previous snapshot for this owner.
    const second = await startExport(h.pool, { workspaceId: ws.id, userId: owner.userId });
    expect(second.exportId).not.toBe(started.exportId);
    await expect(
      readExportPage(h.pool, { workspaceId: ws.id, userId: owner.userId, exportId: started.exportId, signer }),
    ).rejects.toSatisfy((error: unknown) => isTeamError(error) && error.code === "NOT_FOUND");

    // Quota: the bucket allows EXPORTS_PER_HOUR total per workspace.
    for (let i = 0; i < EXPORTS_PER_HOUR - 2; i++) {
      await startExport(h.pool, { workspaceId: ws.id, userId: owner.userId });
    }
    await expect(startExport(h.pool, { workspaceId: ws.id, userId: owner.userId })).rejects.toSatisfy(
      (error: unknown) => isTeamError(error) && error.code === "RATE_LIMITED",
    );
    // Another workspace has its own bucket.
    const otherWs = (await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Export2 ${randomUUID().slice(0, 6)}` })).workspace;
    await expect(startExport(h.pool, { workspaceId: otherWs.id, userId: owner.userId })).resolves.toBeTruthy();
  });
});

describe("recovery window", () => {
  it("rotates epochs, revokes credentials, invalidates cursors, and reconciles the roster", async () => {
    const owner: HumanPrincipal = (await h.asUser("Recovery Owner")).principal;
    const member: HumanPrincipal = (await h.asUser("Recovery Member")).principal;
    const ws = (await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Recovery ${randomUUID().slice(0, 6)}` })).workspace;
    await h.pool.query("INSERT INTO team_memberships (workspace_id, user_id, role, generation) VALUES ($1, $2, 'contributor', gen_random_uuid())", [ws.id, member.userId]);
    const agent = await h.asAgent("recovery-agent", owner.userId, { workspaceId: ws.id, scopes: ["catalog:read"] });
    void agent;
    const seeded = await h.seedPrompt(ws.id);
    const seededRevision = await h.seedRevision(ws.id, seeded.promptId, { authorUserId: owner.userId });
    await h.publishRevision(ws.id, seeded.promptId, seededRevision.revisionId);

    const before = (await h.pool.query<{ server_epoch: string; min_retained_seq: string; next_catalog_seq: string }>(
      "SELECT server_epoch, min_retained_seq::text, next_catalog_seq::text FROM team_workspaces WHERE id = $1",
      [ws.id],
    )).rows[0]!;
    const boot = await startBootstrap(h.pool, {
      principal: owner,
      workspaceId: ws.id,
      membershipGeneration: await generationOf(ws.id, owner.userId),
      serverEpoch: before.server_epoch,
      currentEpoch: before.server_epoch,
      currentGeneration: await generationOf(ws.id, owner.userId),
    });

    const window = await enterRecovery(h.pool, { restoredFrom: "stale-backup.test", note: "drill" });
    expect(window.rotatedEpochs).toBeGreaterThanOrEqual(1);
    expect(window.recoveryId).toBeTruthy();

    const after = (await h.pool.query<{ server_epoch: string; min_retained_seq: string; next_catalog_seq: string }>(
      "SELECT server_epoch, min_retained_seq::text, next_catalog_seq::text FROM team_workspaces WHERE id = $1",
      [ws.id],
    )).rows[0]!;
    expect(after.server_epoch).not.toBe(before.server_epoch);
    // Old feed cursors sit below the floor: they expired with the old world.
    expect(after.min_retained_seq).toBe(after.next_catalog_seq);
    await expect(
      readChanges(h.pool, { workspaceId: ws.id, after: "0", minRetainedSeq: Number(after.min_retained_seq), currentMaxSeq: Number(after.next_catalog_seq) }),
    ).rejects.toSatisfy((error: unknown) => isTeamError(error) && error.code === "CURSOR_EXPIRED");
    // Bootstrap materialization from the old epoch is gone.
    expect((await h.pool.query("SELECT 1 FROM team_bootstraps WHERE snapshot_id = $1", [boot.snapshotId])).rowCount).toBe(0);
    // Credentials revoked across the board.
    expect((await h.pool.query("SELECT 1 FROM team_sessions WHERE revoked_at IS NULL")).rowCount).toBe(0);
    expect((await h.pool.query("SELECT 1 FROM team_agent_tokens WHERE revoked_at IS NULL")).rowCount).toBe(0);

    // Roster reconcile: owner on the roster, member not → member removed.
    const roster = await finishRecoveryWithRoster(h.pool, { rosterEmails: [h.emailFor("Recovery Owner")] });
    expect(roster.removedMemberships).toBe(1);
    expect((await h.pool.query("SELECT 1 FROM team_memberships WHERE workspace_id = $1 AND user_id = $2 AND removed_at IS NULL", [ws.id, member.userId])).rowCount).toBe(0);
    const log = (await h.pool.query<{ finished_at: Date | null }>(
      "SELECT finished_at FROM team_recovery_log WHERE id = $1",
      [roster.recoveryId],
    )).rows[0]!;
    expect(log.finished_at).not.toBeNull();
  });

  it("protects sole-owner workspaces from roster removal", async () => {
    const owner: HumanPrincipal = (await h.asUser("Sole Owner")).principal;
    const ws = (await h.service.createWorkspace(owner, { commandId: randomUUID(), name: `Sole ${randomUUID().slice(0, 6)}` })).workspace;
    void ws;
    await enterRecovery(h.pool, { restoredFrom: "sole-owner.test" });
    const roster = await finishRecoveryWithRoster(h.pool, { rosterEmails: ["nobody@example.test"] });
    expect(roster.lastOwnerProtections).toBeGreaterThanOrEqual(1);
    expect((await h.pool.query("SELECT 1 FROM team_memberships WHERE user_id = $1 AND removed_at IS NULL", [owner.userId])).rowCount).toBe(1);
  });
});
