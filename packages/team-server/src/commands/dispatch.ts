import { z } from "zod";
import type { Pool } from "../db.js";
import { withWorkspaceTransaction } from "../tx.js";
import { teamError } from "../errors.js";
import type { Principal } from "../auth/principal.js";
import { principalId } from "../auth/principal.js";
import {
  commandEnvelopeSchema,
  requiresFreshLogin,
  requiredRole,
  type CommandEnvelope,
} from "./operations.js";
import { findWorkspaceReceipt, persistWorkspaceReceipt, requestHash } from "./receipts.js";
import { authorizeOperation, loadMembership } from "../domain/authorization.js";
import { deleteWorkspace, renameWorkspace } from "../domain/workspaces.js";
import { changeMemberRole, removeMember } from "../domain/memberships.js";
import { createInvitation, revokeInvitation } from "../domain/invitations.js";
import { seedPrompt, updatePromptMetadata, setPromptArchived, rollbackPrompt } from "../domain/prompts.js";
import { submitProposal, withdrawProposal, reviewProposal, addComment } from "../domain/proposals.js";
import { createOrgEntity, renameOrgEntity, deleteOrgEntity, type OrgEntity } from "../domain/organization.js";
import type { SecretBox } from "../auth/crypto.js";

/**
 * Audited command dispatch (contract §C6). Ordering inside the locked
 * workspace transaction is load-bearing: authenticate context, check
 * current permissions AND generation, resolve the command receipt, validate
 * expected versions, mutate, append audit, persist receipt, commit. An
 * unauthorized or membership-changed caller is rejected BEFORE any receipt
 * lookup — a removed member replaying an old command gets 403, never data.
 */

export interface DispatchOptions {
  pool: Pool;
  /** Encrypts the invitation email outbox payload. */
  secretBox: SecretBox;
  publicOrigin: string;
}

export interface CommandReceipt {
  commandId: string;
  committedAt: string;
  /** Non-catalogue commands never advance the per-workspace feed sequence. */
  catalogSeq: string;
  result: { kind: string; id: string; entityVersion?: number };
}

export interface DispatchSuccess extends CommandReceipt {
  /** Raw invitation token — present exactly once, on the creating response. */
  invitationToken?: string;
  invitationExpiresAt?: string;
}

export async function executeTeamCommand(
  options: DispatchOptions,
  principal: Principal,
  workspaceId: string,
  epoch: string,
  rawEnvelope: unknown,
): Promise<DispatchSuccess> {
  const parsed = commandEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) {
    throw teamError("VALIDATION_FAILED", `Invalid command envelope: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const envelope: CommandEnvelope = parsed.data;

  return withWorkspaceTransaction(options.pool, { workspaceId, commandId: envelope.commandId }, async ({ tx, workspace }) => {
    if (!epoch || !/^[0-9a-fA-F-]{36}$/.test(epoch)) {
      throw teamError("VALIDATION_FAILED", "X-PromptBranch-Team-Epoch header is required");
    }
    if (workspace.server_epoch !== epoch) {
      throw teamError("SERVER_EPOCH_CHANGED", "Server epoch changed; bootstrap again");
    }

    // Authorization and generation come from the CURRENT row — never the
    // envelope — and run before the receipt lookup.
    const membership = await loadMembership(tx, workspaceId, principal);
    authorizeOperation(membership, {
      requiredRole: requiredRole(envelope.operation),
      generation: envelope.membershipGeneration,
    });

    const principalIdentifier = principalId(principal);
    const hash = requestHash({
      principalId: principalIdentifier,
      workspaceId,
      membershipGeneration: envelope.membershipGeneration,
      commandId: envelope.commandId,
      operation: envelope.operation,
    });

    const existing = await findWorkspaceReceipt(tx, {
      workspaceId,
      principalId: principalIdentifier,
      commandId: envelope.commandId,
    });
    if (existing) {
      const stored = await tx.query<{ request_hash: Buffer }>(
        "SELECT request_hash FROM team_command_receipts WHERE workspace_id = $1 AND principal_id = $2 AND command_id = $3",
        [workspaceId, principalIdentifier, envelope.commandId],
      );
      if (!stored.rows[0] || !stored.rows[0].request_hash.equals(hash)) {
        throw teamError("COMMAND_ID_REUSED", "commandId was already used with a different request");
      }
      return {
        commandId: envelope.commandId,
        committedAt: existing.committedAt.toISOString(),
        catalogSeq: "0",
        result: existing.resultJson,
      };
    }

    if (requiresFreshLogin(envelope.operation) && principal.kind === "human") {
      const age = Date.now() - Date.parse(principal.authenticatedAt);
      if (!Number.isFinite(age) || age > 10 * 60_000) {
        throw teamError("UNAUTHENTICATED", "This command requires a fresh login");
      }
    }

    let result: { kind: string; id: string; entityVersion?: number };
    let extras: { invitationToken?: string; invitationExpiresAt?: string; mediumFindings?: unknown[] } = {};
    switch (envelope.operation.type) {
      case "workspace.rename": {
        const updated = await renameWorkspace(tx, workspaceId, principal, envelope.operation);
        result = { kind: "workspace", id: workspaceId, entityVersion: updated.entityVersion };
        break;
      }
      case "workspace.delete": {
        const authenticatedAt = principal.kind === "human" ? new Date(principal.authenticatedAt) : new Date(NaN);
        const updated = await deleteWorkspace(tx, workspaceId, principal, {
          confirmName: envelope.operation.confirmName,
          expectedEntityVersion: envelope.operation.expectedEntityVersion,
          authenticatedAt,
        });
        result = { kind: "workspace", id: workspaceId, entityVersion: updated.entityVersion };
        break;
      }
      case "member.role": {
        const updated = await changeMemberRole(tx, workspaceId, principal, envelope.operation);
        result = { kind: "member", id: envelope.operation.userId, entityVersion: updated.entityVersion };
        break;
      }
      case "member.remove": {
        const updated = await removeMember(tx, workspaceId, principal, envelope.operation);
        result = { kind: "member", id: envelope.operation.userId, entityVersion: updated.entityVersion };
        break;
      }
      case "invitation.create": {
        const nameRow = await tx.query<{ name: string }>("SELECT name FROM team_workspaces WHERE id = $1", [workspaceId]);
        const created = await createInvitation(tx, {
          workspaceId,
          actor: principal,
          email: envelope.operation.email,
          role: envelope.operation.role,
          workspaceName: nameRow.rows[0]?.name ?? "a workspace",
          publicOrigin: options.publicOrigin,
          secretBox: options.secretBox,
        });
        result = { kind: "invitation", id: created.invitationId };
        extras = { invitationToken: created.token, invitationExpiresAt: created.expiresAt.toISOString() };
        break;
      }
      case "invitation.revoke": {
        const revoked = await revokeInvitation(tx, {
          workspaceId,
          actor: principal,
          invitationId: envelope.operation.invitationId,
        });
        result = { kind: "invitation", id: revoked.id };
        break;
      }
      case "prompt.create": {
        const seeded = await seedPrompt(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "prompt", id: seeded.promptId, entityVersion: seeded.entityVersion };
        break;
      }
      case "prompt.metadata": {
        const updated = await updatePromptMetadata(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "prompt", id: envelope.operation.promptId, entityVersion: updated.entityVersion };
        break;
      }
      case "prompt.archive":
      case "prompt.restore": {
        const updated = await setPromptArchived(tx, {
          workspaceId,
          actor: principal,
          promptId: envelope.operation.promptId,
          archived: envelope.operation.type === "prompt.archive",
          expectedEntityVersion: envelope.operation.expectedEntityVersion,
        });
        result = { kind: "prompt", id: envelope.operation.promptId, entityVersion: updated.entityVersion };
        break;
      }
      case "prompt.rollback": {
        const updated = await rollbackPrompt(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "prompt", id: envelope.operation.promptId, entityVersion: updated.entityVersion };
        break;
      }
      case "proposal.submit": {
        const submitted = await submitProposal(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "proposal", id: submitted.proposalId, entityVersion: submitted.entityVersion };
        // Medium findings ride along for client preview (contract §C8);
        // high findings already threw SECRET_BLOCKED.
        extras = submitted.mediumFindings.length > 0 ? { mediumFindings: submitted.mediumFindings } : {};
        break;
      }
      case "proposal.withdraw": {
        const updated = await withdrawProposal(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "proposal", id: envelope.operation.proposalId, entityVersion: updated.entityVersion };
        break;
      }
      case "proposal.review": {
        const reviewed = await reviewProposal(tx, { workspaceId, reviewer: principal, ...envelope.operation });
        result = { kind: "review", id: envelope.operation.proposalId, entityVersion: reviewed.entityVersion };
        break;
      }
      case "comment.add": {
        const comment = await addComment(tx, { workspaceId, actor: principal, ...envelope.operation });
        result = { kind: "comment", id: comment.commentId };
        break;
      }
      case "tag.create":
      case "collection.create": {
        const entity: OrgEntity = envelope.operation.type === "tag.create" ? "tag" : "collection";
        const created = await createOrgEntity(tx, { entity, workspaceId, actor: principal, name: envelope.operation.name });
        result = { kind: entity, id: created.id, entityVersion: created.entityVersion };
        break;
      }
      case "tag.rename":
      case "collection.rename": {
        const entity: OrgEntity = envelope.operation.type === "tag.rename" ? "tag" : "collection";
        const updated = await renameOrgEntity(tx, { entity, workspaceId, actor: principal, ...envelope.operation });
        result = { kind: entity, id: envelope.operation.id, entityVersion: updated.entityVersion };
        break;
      }
      case "tag.delete":
      case "collection.delete": {
        const entity: OrgEntity = envelope.operation.type === "tag.delete" ? "tag" : "collection";
        await deleteOrgEntity(tx, { entity, workspaceId, actor: principal, ...envelope.operation });
        result = { kind: entity, id: envelope.operation.id };
        break;
      }
    }

    const committedAt = await persistWorkspaceReceipt(
      tx,
      { workspaceId, principalId: principalIdentifier, commandId: envelope.commandId, requestHash: hash },
      result,
    );
    return {
      commandId: envelope.commandId,
      committedAt: committedAt.toISOString(),
      catalogSeq: "0",
      result,
      ...extras,
    };
  });
}
