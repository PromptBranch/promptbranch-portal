import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamTestHarness, type TeamTestHarness, type HumanPrincipal } from "./helpers";
import { listInvitations } from "../src/domain/invitations";

// Invitations (plan P3; contract §C8): 256-bit tokens hashed at rest,
// 7-day expiry, identity-bound acceptance, revoke+create resend semantics,
// quota, and the transactional email outbox.

let h: TeamTestHarness;
let alice: HumanPrincipal;

async function invite(
  principal: HumanPrincipal,
  workspace: { id: string; serverEpoch: string; membershipGeneration: string },
  email: string,
  role: "maintainer" | "contributor" | "viewer" = "contributor",
) {
  return h.service.execute(principal, workspace.id, workspace.serverEpoch, {
    commandId: randomUUID(),
    membershipGeneration: workspace.membershipGeneration,
    operation: { type: "invitation.create", email, role },
  });
}

beforeAll(async () => {
  h = await createTeamTestHarness();
  alice = (await h.asUser("Alice Invite")).principal;
});
afterAll(async () => {
  await h.close();
});

describe("invitation.create", () => {
  it("returns the raw token once, stores only its hash, and enqueues the email job", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Invite WS" });
    const w = created.workspace;
    const receipt = await invite(alice, w, h.emailFor("Casey Accept"), "contributor");
    expect(receipt.result.kind).toBe("invitation");
    expect(receipt.invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await h.pool.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM team_invitations WHERE id = $1",
      [receipt.result.id],
    );
    expect(row.rows[0]!.token_hash.length).toBe(32); // sha256 of the 256-bit token
    // The raw token appears nowhere at rest — invitations or the job payload.
    const jobRow = await h.pool.query<{ payload_encrypted: Buffer }>(
      "SELECT payload_encrypted FROM team_jobs WHERE type = 'invitation.email' AND workspace_id = $1",
      [w.id],
    );
    expect(jobRow.rows).toHaveLength(1);
    expect(jobRow.rows[0]!.payload_encrypted.toString("utf8")).not.toContain(receipt.invitationToken!);

    const listed = await listInvitations(h.pool, w.id);
    expect(listed[0]).toMatchObject({ email: h.emailFor("Casey Accept"), role: "contributor", status: "pending" });
  });

  it("refuses owner grants and enforces the hourly quota", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Quota WS" });
    const w = created.workspace;
    await expect(invite(alice, w, "owner@example.com", "maintainer")).resolves.toBeTruthy(); // maintainer is fine
    await expect(
      h.service.execute(alice, w.id, w.serverEpoch, {
        commandId: randomUUID(),
        membershipGeneration: w.membershipGeneration,
        operation: { type: "invitation.create", email: "owner@example.com", role: "owner" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    for (let i = 0; i < 19; i++) {
      // 19 more (one already created above) → at the 21st the quota trips.
      await invite(alice, w, `bulk${i}@promptbranch.test`, "viewer");
    }
    await expect(invite(alice, w, "over-quota@promptbranch.test", "viewer")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("acceptance", () => {
  it("is identity-bound, idempotent, and re-adds with a fresh generation", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Accept WS" });
    const w = created.workspace;
    const receipt = await invite(alice, w, h.emailFor("Casey Accept"), "contributor");
    const token = receipt.invitationToken!;
    const casey = (await h.asUser("Casey Accept")).principal; // verified email matches the invitation
    const bob = (await h.asUser("Bob Othermail")).principal; // different verified email

    // Wrong verified identity.
    await expect(h.service.acceptInvitation(bob, { commandId: randomUUID(), token })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    // Acceptance succeeds and grants the invited role.
    const commandId = randomUUID();
    const accepted = await h.service.acceptInvitation(casey, { commandId, token });
    expect(accepted.accepted).toBe(true);
    expect(accepted.workspace.role).toBe("contributor");

    // Same command replays idempotently; the token is consumed for others.
    const replay = await h.service.acceptInvitation(casey, { commandId, token });
    expect(replay.accepted).toBe(false);
    expect(replay.workspace.id).toBe(accepted.workspace.id);
    await expect(h.service.acceptInvitation(bob, { commandId: randomUUID(), token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Remove Casey, then re-invite: the new acceptance rotates generations.
    const caseyRow = await h.pool.query<{ entity_version: number }>(
      "SELECT entity_version FROM team_memberships WHERE workspace_id = $1 AND user_id = $2",
      [w.id, casey.userId],
    );
    await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "member.remove", userId: casey.userId, expectedEntityVersion: caseyRow.rows[0]!.entity_version },
    });
    const reinvite = await invite(alice, w, h.emailFor("Casey Accept"), "maintainer");
    const reaccepted = await h.service.acceptInvitation(casey, { commandId: randomUUID(), token: reinvite.invitationToken! });
    expect(reaccepted.workspace.membershipGeneration).not.toBe(accepted.workspace.membershipGeneration);
    expect(reaccepted.workspace.role).toBe("maintainer");
  });

  it("rejects expired and revoked tokens uniformly", async () => {
    const created = await h.service.createWorkspace(alice, { commandId: randomUUID(), name: "Expiry WS" });
    const w = created.workspace;

    const expiredReceipt = await invite(alice, w, h.emailFor("Dana Expiry"));
    await h.pool.query("UPDATE team_invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [
      expiredReceipt.result.id,
    ]);
    const dana = (await h.asUser("Dana Expiry")).principal;
    await expect(h.service.acceptInvitation(dana, { commandId: randomUUID(), token: expiredReceipt.invitationToken! })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const revokedReceipt = await invite(alice, w, h.emailFor("Erin Revoked"));
    await h.service.execute(alice, w.id, w.serverEpoch, {
      commandId: randomUUID(),
      membershipGeneration: w.membershipGeneration,
      operation: { type: "invitation.revoke", invitationId: revokedReceipt.result.id },
    });
    const erin = (await h.asUser("Erin Revoked")).principal;
    await expect(h.service.acceptInvitation(erin, { commandId: randomUUID(), token: revokedReceipt.invitationToken! })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const listed = await listInvitations(h.pool, w.id);
    expect(listed.find((i) => i.id === revokedReceipt.result.id)?.status).toBe("revoked");
  });
});
