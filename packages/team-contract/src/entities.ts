import { z } from "zod";
import { contentHashSchema, idSchema, seqSchema, timestampSchema } from "./ids.js";
import {
  contentSchema,
  descriptionSchema,
  entityVersionSchema,
  MAX_COLLECTIONS_PER_PROMPT,
  MAX_TAGS_PER_PROMPT,
  titleSchema,
} from "./limits.js";

/**
 * Entity DTOs from C3. These appear in responses, so unknown additive fields
 * are tolerated (stripped) per C2; discriminated kinds remain closed.
 */
export const roleSchema = z.enum(["owner", "maintainer", "contributor", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const scopeSchema = z.enum([
  "catalog:read",
  "proposal:write",
  "note:write",
  "run:write",
]);
export type Scope = z.infer<typeof scopeSchema>;

export const actorSchema = z.object({
  userId: idSchema,
  displayName: z.string().min(1).max(200),
  agentTokenId: idSchema.nullable(),
});
export type Actor = z.infer<typeof actorSchema>;

export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  role: roleSchema,
  membershipGeneration: idSchema,
  serverEpoch: idSchema,
  entityVersion: entityVersionSchema,
  updatedAt: timestampSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const promptSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: titleSchema,
  description: descriptionSchema,
  approvedRevisionId: idSchema,
  tagIds: z.array(idSchema).max(MAX_TAGS_PER_PROMPT),
  collectionIds: z.array(idSchema).max(MAX_COLLECTIONS_PER_PROMPT),
  entityVersion: entityVersionSchema,
  archivedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Prompt = z.infer<typeof promptSchema>;

export const revisionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  promptId: idSchema,
  parentRevisionId: idSchema.nullable(),
  content: contentSchema,
  contentFormat: z.literal("markdown"),
  contentHash: contentHashSchema,
  changeNote: z.string(),
  author: actorSchema,
  createdAt: timestampSchema,
});
export type Revision = z.infer<typeof revisionSchema>;

export const proposalStatusSchema = z.enum([
  "open",
  "approved",
  "rejected",
  "withdrawn",
  "superseded",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  promptId: idSchema,
  baseRevisionId: idSchema,
  candidateRevisionId: idSchema,
  rationale: z.string().max(8000),
  author: actorSchema,
  status: proposalStatusSchema,
  supersedesProposalId: idSchema.nullable(),
  entityVersion: entityVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;

export const reviewSchema = z.object({
  id: idSchema,
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  candidateContentHash: contentHashSchema,
  reviewer: actorSchema,
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(8000),
  createdAt: timestampSchema,
});
export type Review = z.infer<typeof reviewSchema>;

export const tagSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(50),
  entityVersion: entityVersionSchema,
});
export type Tag = z.infer<typeof tagSchema>;

export const collectionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(100),
  entityVersion: entityVersionSchema,
});
export type Collection = z.infer<typeof collectionSchema>;

export const commentSchema = z.object({
  id: idSchema,
  proposalId: idSchema,
  body: z.string().max(8000),
  author: actorSchema,
  createdAt: timestampSchema,
});
export type Comment = z.infer<typeof commentSchema>;

export const runMetricsSchema = z.object({
  model: z.string().nullable(),
  status: z.enum(["completed", "failed", "cancelled"]),
  latencyMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  estimatedCostUsd: z.number().min(0).nullable(),
});
export type RunMetrics = z.infer<typeof runMetricsSchema>;

export const activityItemSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  promptId: idSchema,
  revisionId: idSchema,
  author: actorSchema,
  kind: z.enum(["note", "run"]),
  body: z.string().max(8000),
  createdAt: timestampSchema,
  run: runMetricsSchema.nullable(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const catalogRecordSchema = z.discriminatedUnion("entity", [
  z.object({ entity: z.literal("prompt"), value: promptSchema }),
  z.object({ entity: z.literal("revision"), value: revisionSchema }),
  z.object({ entity: z.literal("tag"), value: tagSchema }),
  z.object({ entity: z.literal("collection"), value: collectionSchema }),
]);
export type CatalogRecord = z.infer<typeof catalogRecordSchema>;

export const tombstoneSchema = z.object({
  entity: z.enum(["prompt", "tag", "collection"]),
  id: idSchema,
});
export type Tombstone = z.infer<typeof tombstoneSchema>;

export const changeSchema = z.object({
  seq: seqSchema,
  records: z.array(catalogRecordSchema),
  tombstones: z.array(tombstoneSchema),
});
export type Change = z.infer<typeof changeSchema>;

/** `Page<T>` from C3: `{ items, nextPageToken }`. */
export function pageOf<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextPageToken: z.string().nullable(),
  });
}
export type Page<T> = { items: T[]; nextPageToken: string | null };
