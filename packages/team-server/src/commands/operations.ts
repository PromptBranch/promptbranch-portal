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

const idList = (max: number) => z.array(uuid).max(max);

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
  // ---- P4: approved libraries and collaboration ------------------------
  z.strictObject({
    type: z.literal("prompt.create"),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    content: z.string().min(1).max(65_536),
    tagIds: idList(20).default([]),
    collectionIds: idList(20).default([]),
    changeNote: z.string().max(8000).default(""),
  }),
  z.strictObject({
    type: z.literal("prompt.metadata"),
    promptId: uuid,
    title: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    tagIds: idList(20).default([]),
    collectionIds: idList(20).default([]),
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("prompt.archive"),
    promptId: uuid,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("prompt.restore"),
    promptId: uuid,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("prompt.rollback"),
    promptId: uuid,
    targetRevisionId: uuid,
    expectedApprovedRevisionId: uuid,
    reason: z.string().min(1).max(8000),
  }),
  z.strictObject({
    type: z.literal("proposal.submit"),
    promptId: uuid,
    baseRevisionId: uuid,
    content: z.string().min(1).max(65_536),
    rationale: z.string().refine((v) => v.trim().length >= 1 && v.length <= 8000, {
      message: "rationale must be nonblank and at most 8000 characters",
    }),
    supersedesProposalId: uuid.nullable().default(null),
  }),
  z.strictObject({
    type: z.literal("proposal.withdraw"),
    proposalId: uuid,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("proposal.review"),
    proposalId: uuid,
    expectedEntityVersion: positiveVersion,
    candidateRevisionId: uuid,
    candidateContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedApprovedRevisionId: uuid,
    decision: z.enum(["approve", "reject"]),
    comment: z.string().max(8000).default(""),
  }),
  z.strictObject({
    type: z.literal("comment.add"),
    proposalId: uuid,
    body: z.string().refine((v) => v.trim().length >= 1 && v.length <= 8000, {
      message: "comment must be nonblank and at most 8000 characters",
    }),
  }),
  z.strictObject({
    type: z.literal("tag.create"),
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= 50, {
      message: "tag name must be 1-50 characters after trimming",
    }),
  }),
  z.strictObject({
    type: z.literal("tag.rename"),
    id: uuid,
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= 50, {
      message: "tag name must be 1-50 characters after trimming",
    }),
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("tag.delete"),
    id: uuid,
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("collection.create"),
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= 100, {
      message: "collection name must be 1-100 characters after trimming",
    }),
  }),
  z.strictObject({
    type: z.literal("collection.rename"),
    id: uuid,
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= 100, {
      message: "collection name must be 1-100 characters after trimming",
    }),
    expectedEntityVersion: positiveVersion,
  }),
  z.strictObject({
    type: z.literal("collection.delete"),
    id: uuid,
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
      return "contributor";
  }
}

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
  | "collection";

export function resultKind(operation: WorkspaceOperation): CommandResultKind {
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
  }
}
