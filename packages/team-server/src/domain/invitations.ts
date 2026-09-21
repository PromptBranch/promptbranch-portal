import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../db.js";
import { withTransaction } from "../db.js";
import { teamError } from "../errors.js";
import { randomTokenUrlSafe, sha256Bytes, type SecretBox } from "../auth/crypto.js";
import type { Principal } from "../auth/principal.js";
import type { TeamRole } from "../commands/operations.js";
import { findUserReceipt, persistUserReceipt, requestHash } from "../commands/receipts.js";
import { appendAudit } from "./audit.js";
import { enqueueJob } from "../jobs/outbox.js";

/**
 * Invitations (contract §C8): single-use 256-bit tokens stored hashed,
 * bound to the invited normalized verified email, expiring in 7 days.
 * Owner role is never grantable. The email with the raw accept URL is a
 * transactional outbox job — send never precedes commit, and the encrypted
 * payload is cleared once delivery succeeds.
 */

export const INVITATION_EXPIRY_DAYS = 7;
export const INVITATIONS_PER_HOUR_PER_WORKSPACE = 20;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface InvitationSummary {
  id: string;
  email: string;
  role: TeamRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
}

/** invitation.create command handler — returns the raw token exactly once. */
export async function createInvitation(
  tx: PoolClient,
  input: { workspaceId: string; actor: Principal; email: string; role: TeamRole; workspaceName: string; publicOrigin: string; secretBox: SecretBox },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  if (input.role === "owner") {
    throw teamError("VALIDATION_FAILED", "Invitations cannot grant the owner role");
  }
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw teamError("VALIDATION_FAILED", "A valid email address is required");
  }
  // Hourly invitation quota, enforced transactionally (contract §C8).
  const recent = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM team_invitations
      WHERE workspace_id = $1 AND created_at > now() - interval '1 hour'`,
    [input.workspaceId],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= INVITATIONS_PER_HOUR_PER_WORKSPACE) {
    throw teamError("RATE_LIMITED", `Invitation quota exceeded (${INVITATIONS_PER_HOUR_PER_WORKSPACE}/hour/workspace)`, {
      details: { retryAfterSeconds: 3600 },
    });
  }

  const invitationId = randomUUID();
  const token = randomTokenUrlSafe(32);
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await tx.query(
    `INSERT INTO team_invitations (id, workspace_id, email, role, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [invitationId, input.workspaceId, email, input.role, sha256Bytes(token), input.actor.kind === "human" ? input.actor.userId : null, expiresAt],
  );
  // Outbox insert joins the mutation transaction: no email without a
  // committed invitation, no invitation without a queued email.
  await enqueueJob(tx, {
    workspaceId: input.workspaceId,
    type: "invitation.email",
    payload: {
      to: email,
      workspaceName: input.workspaceName,
      // First-party accept URL only; no third-party assets, no tracking.
      acceptUrl: `${input.publicOrigin.replace(/\/$/, "")}/team/invitations/accept?token=${token}`,
    },
    secretBox: input.secretBox,
  });
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "invitation.create",
    resourceType: "invitation",
    resourceId: invitationId,
    metadata: { role: input.role },
  });
  return { invitationId, token, expiresAt };
}

/** invitation.revoke command handler — resend is revoke + new invitation. */
export async function revokeInvitation(
  tx: PoolClient,
  input: { workspaceId: string; actor: Principal; invitationId: string },
): Promise<{ id: string }> {
  const result = await tx.query<{ id: string }>(
    `UPDATE team_invitations SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL AND accepted_at IS NULL
      RETURNING id`,
    [input.invitationId, input.workspaceId],
  );
  if (!result.rows[0]) {
    // Already revoked/accepted, or it never belonged to this workspace —
    // indistinguishable by design.
    const existing = await tx.query<{ id: string }>(
      "SELECT id FROM team_invitations WHERE id = $1 AND workspace_id = $2",
      [input.invitationId, input.workspaceId],
    );
    if (!existing.rows[0]) throw teamError("NOT_FOUND", "Invitation not found");
  }
  await appendAudit(tx, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "invitation.revoke",
    resourceType: "invitation",
    resourceId: input.invitationId,
  });
  return { id: input.invitationId };
}

/** GET /workspaces/:w/invitations — owner only; the raw token never leaves storage. */
export async function listInvitations(pool: Pool, workspaceId: string): Promise<InvitationSummary[]> {
  const result = await pool.query<{
    id: string;
    email: string;
    role: TeamRole;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, email, role, expires_at, accepted_at, revoked_at
       FROM team_invitations
      WHERE workspace_id = $1
      ORDER BY created_at DESC, id
      LIMIT 200`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : row.expires_at.getTime() <= Date.now() ? "expired" : "pending",
    expiresAt: row.expires_at.toISOString(),
  }));
}

export interface AcceptInvitationInput {
  commandId: string;
  token: string;
}

export interface AcceptInvitationResult {
  workspace: { id: string; name: string; role: TeamRole; membershipGeneration: string; serverEpoch: string; entityVersion: number; updatedAt: string };
  accepted: boolean;
}

/**
 * POST /invitations/accept — explicit, identity-bound, idempotent. The
 * accepting verified email must match the invitation's email; GET never
 * consumes anything (this is the only consuming path). Re-accepting with a
 * new commandId while membership is still active is a friendly no-op;
 * accepting after removal re-adds with a FRESH generation.
 */
export async function acceptInvitation(
  pool: Pool,
  input: { principal: Principal; secretBox: SecretBox; publicOrigin?: string },
  body: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  if (input.principal.kind !== "human") {
    throw teamError("ROLE_FORBIDDEN", "Invitations are accepted by humans");
  }
  const principal = input.principal;
  const hash = requestHash({ kind: "invitation.accept", userId: principal.userId, token: body.token, commandId: body.commandId });

  return withTransaction(pool, async (tx) => {
    const replay = await findUserReceipt(tx, { userId: principal.userId, commandId: body.commandId });
    if (replay) {
      const workspace = await loadAcceptedWorkspace(tx, principal, replay.resultJson.id);
      return { workspace, accepted: false };
    }

    const invitation = (await tx.query<{
      id: string;
      workspace_id: string;
      email: string;
      role: TeamRole;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      "SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at FROM team_invitations WHERE token_hash = $1 FOR UPDATE",
      [sha256Bytes(body.token)],
    )).rows[0];
    // Unknown, revoked, already-accepted and expired tokens are uniformly
    // NOT_FOUND: the accepter learns nothing beyond "not usable".
    if (!invitation || invitation.revoked_at || invitation.accepted_at || invitation.expires_at.getTime() <= Date.now()) {
      throw teamError("NOT_FOUND", "Invitation not found");
    }

    const user = (await tx.query<{ normalized_email: string }>(
      "SELECT normalized_email FROM team_users WHERE id = $1",
      [principal.userId],
    )).rows[0];
    if (!user || user.normalized_email !== invitation.email) {
      throw teamError("VALIDATION_FAILED", "This invitation was issued to a different email address");
    }
    const workspace = (await tx.query<{ name: string; deleted_at: Date | null }>(
      "SELECT name, deleted_at FROM team_workspaces WHERE id = $1",
      [invitation.workspace_id],
    )).rows[0];
    if (!workspace || workspace.deleted_at) throw teamError("NOT_FOUND", "Invitation not found");

    const generation = randomUUID();
    const upsert = await tx.query<{ entity_version: number }>(
      `INSERT INTO team_memberships (workspace_id, user_id, role, generation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE
         SET role = EXCLUDED.role,
             generation = EXCLUDED.generation,
             removed_at = NULL,
             entity_version = team_memberships.entity_version + 1,
             updated_at = now()
       RETURNING entity_version`,
      [invitation.workspace_id, principal.userId, invitation.role, generation],
    );
    await tx.query(
      "UPDATE team_invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1",
      [invitation.id, principal.userId],
    );
    await appendAudit(tx, {
      workspaceId: invitation.workspace_id,
      actor: principal,
      action: "invitation.accept",
      resourceType: "invitation",
      resourceId: invitation.id,
      metadata: { role: invitation.role },
    });
    await persistUserReceipt(
      tx,
      { userId: principal.userId, commandId: body.commandId, requestHash: hash },
      { kind: "workspace", id: invitation.workspace_id },
    );
    const fresh = await loadAcceptedWorkspace(tx, principal, invitation.workspace_id);
    return { workspace: { ...fresh, membershipGeneration: generation }, accepted: true };
  });
}

async function loadAcceptedWorkspace(
  tx: PoolClient,
  principal: Principal,
  workspaceId: string,
): Promise<AcceptInvitationResult["workspace"]> {
  const row = (await tx.query<{
    id: string;
    name: string;
    server_epoch: string;
    entity_version: number;
    updated_at: Date;
    role: TeamRole;
    generation: string;
  }>(
    `SELECT w.id, w.name, w.server_epoch, w.entity_version, w.updated_at, m.role, m.generation
       FROM team_workspaces w JOIN team_memberships m ON m.workspace_id = w.id AND m.user_id = $2
      WHERE w.id = $1 AND w.deleted_at IS NULL AND m.removed_at IS NULL`,
    [workspaceId, principal.kind === "human" ? principal.userId : ""],
  )).rows[0];
  if (!row) throw teamError("NOT_FOUND", "Workspace not found");
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    membershipGeneration: row.generation,
    serverEpoch: row.server_epoch,
    entityVersion: row.entity_version,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Exposed for the email job renderer; nothing else needs the raw token. */
export function invitationEmailContext(token: string, workspaceName: string, publicOrigin: string): { to?: string; acceptUrl: string; workspaceName: string } {
  return { acceptUrl: `${publicOrigin.replace(/\/$/, "")}/team/invitations/accept?token=${token}`, workspaceName };
}

