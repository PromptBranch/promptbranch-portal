import type { CommandEnvelope, TeamOperation } from "@promptbranch/team-contract";
import { commandEnvelopeSchema, teamOperationSchema, roleSchema } from "@promptbranch/team-contract";
import type { z } from "zod";
import type { Scope } from "../auth/principal.js";

/**
 * G0: request schemas come from the owned `@promptbranch/team-contract`
 * artifact (vendored at packages/team-contract; provenance and per-file
 * hashes in docs-internal/contracts/D0-provenance.md). This module keeps
 * only the portal's POLICY decisions from the C4 table — role floors,
 * agent scope/allowlist rules, fresh-login requirements and result kinds —
 * which are server behavior, not wire shape.
 *
 * Strictness note: the artifact makes optional-looking fields REQUIRED
 * (tagIds, collectionIds, description, changeNote, comment,
 * supersedesProposalId) — clients must send them explicitly, matching the
 * C4 field lists. The embedded PB-TEAM-1 bound list (§C2 line 84) bounds
 * rationale/comment/note at 8,000 but deliberately leaves changeNote a
 * plain string; the request byte cap is its effective bound.
 */

export { commandEnvelopeSchema, teamOperationSchema };
export type { CommandEnvelope, TeamOperation };

/** Historical local name for the operation union. */
export type WorkspaceOperation = TeamOperation;

/** The C4 Role vocabulary (re-exported so callers share one definition). */
export const teamRoleSchema = roleSchema;
export type TeamRole = z.infer<typeof roleSchema>;

/** Roles an invitation may grant (owner is never grantable by invitation). */
export const invitableRoleSchema = roleSchema.exclude(["owner"]);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/** The one operation that requires a fresh sign-in (contract §C4). */
export function requiresFreshLogin(operation: TeamOperation): boolean {
  return operation.type === "workspace.delete";
}

/** Minimum role each operation demands (C4 table; server-side truth). */
export function requiredRole(operation: TeamOperation): TeamRole {
  switch (operation.type) {
    // Membership/invitation/workspace management stays owner-only (C4).
    case "invitation.create":
    case "invitation.revoke":
    case "member.role":
    case "member.remove":
    case "workspace.rename":
    case "workspace.delete":
      return "owner";
    case "prompt.create":
    case "prompt.metadata":
    case "prompt.archive":
    case "prompt.restore":
    case "prompt.rollback":
    case "proposal.review":
    case "tag.create":
    case "tag.rename":
    case "tag.delete":
    case "collection.create":
    case "collection.rename":
    case "collection.delete":
      return "maintainer";
    case "proposal.submit":
    case "proposal.withdraw":
    case "comment.add":
    case "note.add":
    case "run.report":
      return "contributor";
  }
}

/** Scopes an AGENT principal must hold for an operation (humans need none). */
export function requiredScopes(operation: TeamOperation): Scope[] {
  switch (operation.type) {
    case "proposal.submit":
    case "proposal.withdraw":
    case "comment.add":
      return ["proposal:write"];
    case "note.add":
      return ["note:write"];
    case "run.report":
      return ["run:write"];
    default:
      return [];
  }
}

/** Operations an agent may execute at all — everything else is human-only. */
export const AGENT_ALLOWED_OPERATIONS: ReadonlySet<TeamOperation["type"]> = new Set([
  "proposal.submit",
  "proposal.withdraw",
  "comment.add",
  "note.add",
  "run.report",
]);

/** Result kind reported in the CommandReceipt (contract §C4 table). */
export type CommandResultKind =
  | "invitation"
  | "member"
  | "workspace"
  | "prompt"
  | "proposal"
  | "review"
  | "comment"
  | "tag"
  | "collection"
  | "activityItem";

export const SCOPE_VALUES: readonly Scope[] = ["catalog:read", "proposal:write", "note:write", "run:write"];

export function resultKind(operation: TeamOperation): CommandResultKind {
  switch (operation.type) {
    case "invitation.create":
    case "invitation.revoke":
      return "invitation";
    case "member.role":
    case "member.remove":
      return "member";
    case "workspace.rename":
    case "workspace.delete":
      return "workspace";
    case "prompt.create":
    case "prompt.metadata":
    case "prompt.archive":
    case "prompt.restore":
    case "prompt.rollback":
      return "prompt";
    case "proposal.submit":
    case "proposal.withdraw":
      return "proposal";
    case "proposal.review":
      return "review";
    case "comment.add":
      return "comment";
    case "tag.create":
    case "tag.rename":
    case "tag.delete":
      return "tag";
    case "collection.create":
    case "collection.rename":
    case "collection.delete":
      return "collection";
    case "note.add":
    case "run.report":
      return "activityItem";
  }
}
