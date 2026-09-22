import { z } from "zod";
import { contentHashSchema, emailSchema, idSchema, seqSchema, timestampSchema } from "./ids.js";
import {
  collectionNameSchema,
  commentBodySchema,
  contentSchema,
  descriptionSchema,
  entityVersionSchema,
  MAX_COLLECTIONS_PER_PROMPT,
  MAX_TAGS_PER_PROMPT,
  rationaleSchema,
  reasonSchema,
  tagNameSchema,
  titleSchema,
  workspaceNameSchema,
} from "./limits.js";
import { roleSchema } from "./entities.js";

/**
 * The C4 `TeamOperation` discriminated union. Every member is a strict object
 * (C2: requests reject unknown fields) and targets the workspace from the URL
 * only — there is deliberately no client-supplied actor field.
 */
const promptCreateOperationSchema = z.strictObject({
  type: z.literal("prompt.create"),
  title: titleSchema,
  description: descriptionSchema,
  content: contentSchema,
  tagIds: z.array(idSchema).max(MAX_TAGS_PER_PROMPT),
  collectionIds: z.array(idSchema).max(MAX_COLLECTIONS_PER_PROMPT),
  changeNote: z.string(),
});

const promptMetadataOperationSchema = z.strictObject({
  type: z.literal("prompt.metadata"),
  promptId: idSchema,
  title: titleSchema,
  description: descriptionSchema,
  tagIds: z.array(idSchema).max(MAX_TAGS_PER_PROMPT),
  collectionIds: z.array(idSchema).max(MAX_COLLECTIONS_PER_PROMPT),
  expectedEntityVersion: entityVersionSchema,
});

const promptArchiveOperationSchema = z.strictObject({
  type: z.literal("prompt.archive"),
  promptId: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const promptRestoreOperationSchema = z.strictObject({
  type: z.literal("prompt.restore"),
  promptId: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const promptRollbackOperationSchema = z.strictObject({
  type: z.literal("prompt.rollback"),
  promptId: idSchema,
  targetRevisionId: idSchema,
  expectedApprovedRevisionId: idSchema,
  reason: reasonSchema,
});

const proposalSubmitOperationSchema = z.strictObject({
  type: z.literal("proposal.submit"),
  promptId: idSchema,
  baseRevisionId: idSchema,
  content: contentSchema,
  rationale: rationaleSchema,
  supersedesProposalId: idSchema.nullable(),
});

const proposalWithdrawOperationSchema = z.strictObject({
  type: z.literal("proposal.withdraw"),
  proposalId: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const proposalReviewOperationSchema = z.strictObject({
  type: z.literal("proposal.review"),
  proposalId: idSchema,
  expectedEntityVersion: entityVersionSchema,
  candidateRevisionId: idSchema,
  candidateContentHash: contentHashSchema,
  expectedApprovedRevisionId: idSchema,
  decision: z.enum(["approve", "reject"]),
  comment: commentBodySchema,
});

const commentAddOperationSchema = z.strictObject({
  type: z.literal("comment.add"),
  proposalId: idSchema,
  body: commentBodySchema,
});

const noteAddOperationSchema = z.strictObject({
  type: z.literal("note.add"),
  promptId: idSchema,
  revisionId: idSchema,
  body: commentBodySchema,
});

const runReportOperationSchema = z.strictObject({
  type: z.literal("run.report"),
  promptId: idSchema,
  revisionId: idSchema,
  body: commentBodySchema,
  model: z.string().nullable(),
  status: z.enum(["completed", "failed", "cancelled"]),
  latencyMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  estimatedCostUsd: z.number().min(0).nullable(),
});

const tagCreateOperationSchema = z.strictObject({
  type: z.literal("tag.create"),
  name: tagNameSchema,
});

const collectionCreateOperationSchema = z.strictObject({
  type: z.literal("collection.create"),
  name: collectionNameSchema,
});

const tagRenameOperationSchema = z.strictObject({
  type: z.literal("tag.rename"),
  id: idSchema,
  name: tagNameSchema,
  expectedEntityVersion: entityVersionSchema,
});

const collectionRenameOperationSchema = z.strictObject({
  type: z.literal("collection.rename"),
  id: idSchema,
  name: collectionNameSchema,
  expectedEntityVersion: entityVersionSchema,
});

const tagDeleteOperationSchema = z.strictObject({
  type: z.literal("tag.delete"),
  id: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const collectionDeleteOperationSchema = z.strictObject({
  type: z.literal("collection.delete"),
  id: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const invitationCreateOperationSchema = z.strictObject({
  type: z.literal("invitation.create"),
  email: emailSchema,
  role: z.enum(["maintainer", "contributor", "viewer"]),
});

const invitationRevokeOperationSchema = z.strictObject({
  type: z.literal("invitation.revoke"),
  invitationId: idSchema,
});

const memberRoleOperationSchema = z.strictObject({
  type: z.literal("member.role"),
  userId: idSchema,
  role: roleSchema,
  expectedEntityVersion: entityVersionSchema,
});

const memberRemoveOperationSchema = z.strictObject({
  type: z.literal("member.remove"),
  userId: idSchema,
  expectedEntityVersion: entityVersionSchema,
});

const workspaceRenameOperationSchema = z.strictObject({
  type: z.literal("workspace.rename"),
  name: workspaceNameSchema,
  expectedEntityVersion: entityVersionSchema,
});

const workspaceDeleteOperationSchema = z.strictObject({
  type: z.literal("workspace.delete"),
  confirmName: workspaceNameSchema,
  expectedEntityVersion: entityVersionSchema,
});

export const teamOperationSchema = z.discriminatedUnion("type", [
  promptCreateOperationSchema,
  promptMetadataOperationSchema,
  promptArchiveOperationSchema,
  promptRestoreOperationSchema,
  promptRollbackOperationSchema,
  proposalSubmitOperationSchema,
  proposalWithdrawOperationSchema,
  proposalReviewOperationSchema,
  commentAddOperationSchema,
  noteAddOperationSchema,
  runReportOperationSchema,
  tagCreateOperationSchema,
  collectionCreateOperationSchema,
  tagRenameOperationSchema,
  collectionRenameOperationSchema,
  tagDeleteOperationSchema,
  collectionDeleteOperationSchema,
  invitationCreateOperationSchema,
  invitationRevokeOperationSchema,
  memberRoleOperationSchema,
  memberRemoveOperationSchema,
  workspaceRenameOperationSchema,
  workspaceDeleteOperationSchema,
]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

export const TEAM_OPERATION_TYPES = [
  "prompt.create",
  "prompt.metadata",
  "prompt.archive",
  "prompt.restore",
  "prompt.rollback",
  "proposal.submit",
  "proposal.withdraw",
  "proposal.review",
  "comment.add",
  "note.add",
  "run.report",
  "tag.create",
  "collection.create",
  "tag.rename",
  "collection.rename",
  "tag.delete",
  "collection.delete",
  "invitation.create",
  "invitation.revoke",
  "member.role",
  "member.remove",
  "workspace.rename",
  "workspace.delete",
] as const;
export type TeamOperationType = (typeof TEAM_OPERATION_TYPES)[number];

/** Receipt result kinds emitted by C4 commands. */
export const RECEIPT_RESULT_KINDS = [
  "prompt",
  "proposal",
  "review",
  "comment",
  "activityItem",
  "tag",
  "collection",
  "invitation",
  "member",
  "workspace",
] as const;

export const commandEnvelopeSchema = z.strictObject({
  commandId: idSchema,
  membershipGeneration: idSchema,
  operation: teamOperationSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const commandReceiptSchema = z.object({
  commandId: idSchema,
  committedAt: timestampSchema,
  catalogSeq: seqSchema,
  result: z.object({
    kind: z.enum(RECEIPT_RESULT_KINDS),
    id: idSchema,
    entityVersion: entityVersionSchema.optional(),
  }),
});
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
