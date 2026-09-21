import { z } from "zod";

/**
 * Command envelope validation — the P3 subset of the PB-TEAM-1 `TeamOperation`
 * union (contract §C4 rows for membership/invitation/workspace management).
 *
 * G0 NOTE: the owned `@promptbranch/team-contract` artifact has not been
 * delivered yet. These schemas mirror the embedded PB-TEAM-1 specification
 * field-for-field and must be REPLACED by the imported contract schemas when
 * the D0 artifact arrives — they are an implementation of the accepted
 * specification, never a divergent alternative. Operations from later phases
 * (prompt, proposal, tag, collection, comment, note, run) are deliberately
 * absent and unknown types are rejected here until their phase lands with
 * the same pattern.
 */

export const teamRoleSchema = z.enum(["owner", "maintainer", "contributor", "viewer"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

const uuid = z.string().uuid();
const positiveVersion = z.number().int().positive();

/** Roles an invitation may grant (owner is never grantable by invitation). */
export const invitableRoleSchema = z.enum(["maintainer", "contributor", "viewer"]);

export const workspaceOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("invitation.create"),
    email: z.email().max(320),
    role: invitableRoleSchema,
  }),
  z.strictObject({
    type: z.literal("invitation.revoke"),
    invitationId: uuid,
  }),
  z.strictObject({
    type: z.literal("member.role"),
    userId: uuid,
    role: teamRoleSchema,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("member.remove"),
    userId: uuid,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("workspace.rename"),
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= 200, {
      message: "name must be 1-200 characters after trimming",
    }),
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("workspace.delete"),
    confirmName: z.string().min(1).max(200),
    expectedEntityVersion: positiveVersion,
  }),
]);

export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;

export const commandEnvelopeSchema = z.strictObject({
  commandId: uuid,
  membershipGeneration: uuid,
  operation: workspaceOperationSchema,
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** The one operation that requires a fresh sign-in (contract §C4). */
export function requiresFreshLogin(operation: WorkspaceOperation): boolean {
  return operation.type === "workspace.delete";
}

/** Minimum role each P3 operation demands (server-side truth, contract §C1). */
export function requiredRole(operation: WorkspaceOperation): TeamRole {
  switch (operation.type) {
    case "invitation.create":
    case "invitation.revoke":
    case "member.role":
    case "member.remove":
    case "workspace.rename":
    case "workspace.delete":
      return "owner";
  }
}

/** Result kind reported in the CommandReceipt (contract §C4 table). */
export function resultKind(operation: WorkspaceOperation): "invitation" | "member" | "workspace" {
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
  }
}
