import { z } from "zod";
import {
  activityItemSchema,
  catalogRecordSchema,
  changeSchema,
  collectionSchema,
  commentSchema,
  pageOf,
  promptSchema,
  proposalSchema,
  proposalStatusSchema,
  reviewSchema,
  revisionSchema,
  roleSchema,
  scopeSchema,
  tagSchema,
  workspaceSchema,
} from "./entities.js";
import { emailSchema, idSchema, seqSchema, timestampSchema } from "./ids.js";
import { commandEnvelopeSchema, commandReceiptSchema } from "./operations.js";
import {
  pageLimitSchema,
  searchQuerySchema,
  teamLimitsSchema,
  workspaceNameSchema,
} from "./limits.js";

/**
 * Route input/output DTOs for the C4 API surface. Inputs are strict objects;
 * outputs tolerate additive fields per C2.
 */
export const PROTOCOL_VERSION = 1;
export const CONTRACT_VERSION = "1.0.0";
export const API_BASE_PATH = "/api/team/v1";
export const PROTOCOL_HEADER = "X-PromptBranch-Team-Protocol";
export const EPOCH_HEADER = "X-PromptBranch-Team-Epoch";
export const REQUEST_ID_HEADER = "X-Request-ID";

/** Features a discovery response must contain before team activation (C2). */
export const REQUIRED_FEATURES = [
  "catalog-v1",
  "review-v1",
  "changes-v1",
  "agent-token-v1",
] as const;

export const teamInfoSchema = z.object({
  protocol: z.literal(1),
  contractVersion: z.string().min(1),
  serverId: idSchema,
  serverEpoch: idSchema,
  features: z.array(z.string()),
  issuer: z.string().min(1),
  nativeClientId: z.string().min(1),
  cliClientId: z.string().min(1),
  audience: z.string().min(1),
  limits: teamLimitsSchema,
});
export type TeamInfo = z.infer<typeof teamInfoSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: idSchema,
    displayName: z.string().min(1).max(200),
    email: emailSchema,
  }),
  workspaces: z.array(workspaceSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const deleteMeInputSchema = z.strictObject({
  confirmEmail: emailSchema,
});
export type DeleteMeInput = z.infer<typeof deleteMeInputSchema>;

export const principalResponseSchema = z.object({
  kind: z.enum(["human", "agent"]),
  principalId: z.string().min(1),
  userId: idSchema,
  agentTokenId: idSchema.nullable(),
  scopes: z.array(scopeSchema),
});
export type PrincipalResponse = z.infer<typeof principalResponseSchema>;

export const createWorkspaceInputSchema = z.strictObject({
  commandId: idSchema,
  name: workspaceNameSchema,
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const workspaceResponseSchema = z.object({ workspace: workspaceSchema });

export const listPromptsQuerySchema = z.object({
  q: searchQuerySchema.optional(),
  tagId: idSchema.optional(),
  collectionId: idSchema.optional(),
  archived: z.boolean().optional(),
  limit: pageLimitSchema.optional(),
  pageToken: z.string().optional(),
});
export type ListPromptsQuery = z.infer<typeof listPromptsQuerySchema>;

export const promptDetailResponseSchema = z.object({
  prompt: promptSchema,
  revision: revisionSchema,
});

export const revisionResponseSchema = z.object({ revision: revisionSchema });

export const listProposalsQuerySchema = z.object({
  promptId: idSchema.optional(),
  status: proposalStatusSchema.optional(),
  limit: pageLimitSchema.optional(),
  pageToken: z.string().optional(),
});

export const proposalDetailResponseSchema = z.object({
  proposal: proposalSchema,
  base: revisionSchema,
  candidate: revisionSchema,
  reviews: z.array(reviewSchema),
});
export type ProposalDetailResponse = z.infer<typeof proposalDetailResponseSchema>;

export const listActivityQuerySchema = z.object({
  promptId: idSchema,
  limit: pageLimitSchema.optional(),
  pageToken: z.string().optional(),
});

export const memberSchema = z.object({
  userId: idSchema,
  displayName: z.string().min(1).max(200),
  email: emailSchema,
  role: roleSchema,
  entityVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type Member = z.infer<typeof memberSchema>;

export const invitationSchema = z.object({
  id: idSchema,
  email: emailSchema,
  role: roleSchema,
  status: z.string().min(1),
  expiresAt: timestampSchema,
});
export type Invitation = z.infer<typeof invitationSchema>;

export const acceptInvitationInputSchema = z.strictObject({
  commandId: idSchema,
  token: z.string().min(1),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;

export const auditEntrySchema = z.object({
  id: idSchema,
  actor: z.object({
    userId: idSchema,
    displayName: z.string().min(1).max(200),
    agentTokenId: idSchema.nullable(),
  }),
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: idSchema,
  createdAt: timestampSchema,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const sessionSchema = z.object({
  id: idSchema,
  clientId: z.string().min(1),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const agentTokenMetadataSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  userId: idSchema,
  scopes: z.array(scopeSchema),
  expiresAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type AgentTokenMetadata = z.infer<typeof agentTokenMetadataSchema>;

export const createAgentTokenInputSchema = z.strictObject({
  commandId: idSchema,
  name: z.string().min(1).max(100),
  scopes: z.array(scopeSchema).min(1),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
export type CreateAgentTokenInput = z.infer<typeof createAgentTokenInputSchema>;

export const agentTokenCreatedSchema = z.object({
  id: idSchema,
  token: z.string().optional(),
  expiresAt: timestampSchema.nullable(),
  secretAvailable: z.boolean(),
});
export type AgentTokenCreated = z.infer<typeof agentTokenCreatedSchema>;

export const bootstrapInputSchema = z.strictObject({
  membershipGeneration: idSchema,
  serverEpoch: idSchema,
});
export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;

export const bootstrapStartSchema = z.object({
  snapshotId: idSchema,
  highWater: seqSchema,
  expiresAt: timestampSchema,
  serverEpoch: idSchema,
  membershipGeneration: idSchema,
});
export type BootstrapStart = z.infer<typeof bootstrapStartSchema>;

export const bootstrapPageSchema = z.object({
  snapshotId: idSchema,
  records: z.array(catalogRecordSchema),
  nextPageToken: z.string().nullable(),
  highWater: seqSchema,
  serverEpoch: idSchema,
  membershipGeneration: idSchema,
});
export type BootstrapPage = z.infer<typeof bootstrapPageSchema>;

export const changesInputSchema = z.object({
  after: seqSchema,
  serverEpoch: idSchema,
  membershipGeneration: idSchema,
  limit: pageLimitSchema.optional(),
});
export type ChangesInput = z.infer<typeof changesInputSchema>;

export const changesPageSchema = z.object({
  changes: z.array(changeSchema),
  nextCursor: seqSchema,
  hasMore: z.boolean(),
  serverEpoch: idSchema,
  membershipGeneration: idSchema,
});
export type ChangesPage = z.infer<typeof changesPageSchema>;

export const healthReadySchema = z.object({ ready: z.boolean() });

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const workspacesPageSchema = pageOf(workspaceSchema);
export const promptsPageSchema = pageOf(promptSchema);
export const revisionsPageSchema = pageOf(revisionSchema);
export const tagsPageSchema = pageOf(tagSchema);
export const collectionsPageSchema = pageOf(collectionSchema);
export const proposalsPageSchema = pageOf(proposalSchema);
export const commentsPageSchema = pageOf(commentSchema);
export const activityItemsPageSchema = pageOf(activityItemSchema);
export const membersPageSchema = pageOf(memberSchema);
export const invitationsPageSchema = pageOf(invitationSchema);
export const auditPageSchema = pageOf(auditEntrySchema);
export const sessionsPageSchema = pageOf(sessionSchema);
export const agentTokensPageSchema = pageOf(agentTokenMetadataSchema);

/** Query parameter descriptor for one route (C4 pagination/filter inputs). */
export interface TeamRouteQuery {
  name: string;
  schema: z.ZodType;
  required?: boolean;
}

export type TeamRouteAuth =
  | "public"
  | "infrastructure"
  | "human"
  | "member"
  | "contributor"
  | "maintainer"
  | "owner";

export interface TeamRoute {
  method: "GET" | "POST" | "DELETE";
  path: string;
  operationId: string;
  summary: string;
  auth: TeamRouteAuth;
  requestBody?: z.ZodType;
  query?: TeamRouteQuery[];
  success: { status: number; schema?: z.ZodType; contentType?: string };
  successAlt?: number[];
}

const paginationQuery: TeamRouteQuery[] = [
  { name: "limit", schema: pageLimitSchema },
  { name: "pageToken", schema: z.string() },
];

/**
 * The C4 API surface, relative to `/api/team/v1`. This table is the single
 * source the OpenAPI document and the compatibility manifest are derived
 * from; the mock server and the real Portal both implement these routes.
 */
export const TEAM_ROUTES: TeamRoute[] = [
  {
    method: "GET",
    path: "/info",
    operationId: "getInfo",
    summary: "Server discovery: protocol, identity, features and limits.",
    auth: "public",
    success: { status: 200, schema: teamInfoSchema },
  },
  {
    method: "GET",
    path: "/me",
    operationId: "getMe",
    summary: "Current human user and joined workspaces.",
    auth: "human",
    success: { status: 200, schema: meResponseSchema },
  },
  {
    method: "DELETE",
    path: "/me",
    operationId: "deleteMe",
    summary: "Self-service account deletion with confirmed email.",
    auth: "human",
    requestBody: deleteMeInputSchema,
    success: { status: 200, schema: okResponseSchema },
  },
  {
    method: "GET",
    path: "/principal",
    operationId: "getPrincipal",
    summary: "Server-authored cache identity for the caller (human or agent).",
    auth: "member",
    success: { status: 200, schema: principalResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces",
    operationId: "listWorkspaces",
    summary: "Workspaces the caller belongs to.",
    auth: "human",
    query: paginationQuery,
    success: { status: 200, schema: workspacesPageSchema },
  },
  {
    method: "POST",
    path: "/workspaces",
    operationId: "createWorkspace",
    summary: "Create a workspace; the creator becomes its sole owner.",
    auth: "human",
    requestBody: createWorkspaceInputSchema,
    success: { status: 201, schema: workspaceResponseSchema },
    successAlt: [200],
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}",
    operationId: "getWorkspace",
    summary: "Workspace with the caller's freshly resolved role and generation.",
    auth: "member",
    success: { status: 200, schema: workspaceResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/prompts",
    operationId: "listPrompts",
    summary: "Approved catalogue browse/search; summary items omit revision content.",
    auth: "member",
    query: [
      { name: "q", schema: searchQuerySchema },
      { name: "tagId", schema: idSchema },
      { name: "collectionId", schema: idSchema },
      { name: "archived", schema: z.boolean() },
      ...paginationQuery,
    ],
    success: { status: 200, schema: promptsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/prompts/{promptId}",
    operationId: "getPrompt",
    summary: "Prompt with its approved head revision.",
    auth: "member",
    success: { status: 200, schema: promptDetailResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/prompts/{promptId}/revisions",
    operationId: "listRevisions",
    summary: "Published revision history, newest first.",
    auth: "member",
    query: paginationQuery,
    success: { status: 200, schema: revisionsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/revisions/{revisionId}",
    operationId: "getRevision",
    summary: "One published revision; candidates are never served here.",
    auth: "member",
    success: { status: 200, schema: revisionResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/tags",
    operationId: "listTags",
    summary: "Workspace tags.",
    auth: "member",
    query: paginationQuery,
    success: { status: 200, schema: tagsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/collections",
    operationId: "listCollections",
    summary: "Workspace collections.",
    auth: "member",
    query: paginationQuery,
    success: { status: 200, schema: collectionsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/proposals",
    operationId: "listProposals",
    summary: "Proposals (contributor+; agents see only their own).",
    auth: "contributor",
    query: [
      { name: "promptId", schema: idSchema },
      { name: "status", schema: proposalStatusSchema },
      ...paginationQuery,
    ],
    success: { status: 200, schema: proposalsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/proposals/{proposalId}",
    operationId: "getProposal",
    summary: "Proposal detail with exact base and candidate revisions.",
    auth: "contributor",
    success: { status: 200, schema: proposalDetailResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/proposals/{proposalId}/comments",
    operationId: "listProposalComments",
    summary: "Comments on a proposal.",
    auth: "contributor",
    query: paginationQuery,
    success: { status: 200, schema: commentsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/activity-items",
    operationId: "listActivityItems",
    summary: "Note and run-summary activity for a prompt.",
    auth: "contributor",
    query: [
      { name: "promptId", schema: idSchema, required: true },
      ...paginationQuery,
    ],
    success: { status: 200, schema: activityItemsPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/members",
    operationId: "listMembers",
    summary: "Workspace members (owner only).",
    auth: "owner",
    query: paginationQuery,
    success: { status: 200, schema: membersPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/invitations",
    operationId: "listInvitations",
    summary: "Workspace invitations without raw tokens (owner only).",
    auth: "owner",
    query: paginationQuery,
    success: { status: 200, schema: invitationsPageSchema },
  },
  {
    method: "POST",
    path: "/invitations/accept",
    operationId: "acceptInvitation",
    summary: "Identity-bound, idempotent invitation acceptance.",
    auth: "human",
    requestBody: acceptInvitationInputSchema,
    success: { status: 200, schema: workspaceResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/audit",
    operationId: "listAudit",
    summary: "Audit log without secrets or content (owner only).",
    auth: "owner",
    query: paginationQuery,
    success: { status: 200, schema: auditPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/export",
    operationId: "exportWorkspace",
    summary: "Owner NDJSON export: manifest then domain entities, no credentials.",
    auth: "owner",
    success: { status: 200, contentType: "application/x-ndjson" },
  },
  {
    method: "GET",
    path: "/sessions",
    operationId: "listSessions",
    summary: "The caller's own sessions.",
    auth: "human",
    query: paginationQuery,
    success: { status: 200, schema: sessionsPageSchema },
  },
  {
    method: "DELETE",
    path: "/sessions/{sessionId}",
    operationId: "revokeSession",
    summary: "Revoke one of the caller's own sessions.",
    auth: "human",
    success: { status: 200, schema: okResponseSchema },
  },
  {
    method: "POST",
    path: "/sessions/revoke-all",
    operationId: "revokeAllSessions",
    summary: "Revoke all of the caller's human sessions and agent tokens.",
    auth: "human",
    success: { status: 200, schema: okResponseSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/agent-tokens",
    operationId: "listAgentTokens",
    summary: "Agent token metadata; the secret is never returned.",
    auth: "human",
    query: paginationQuery,
    success: { status: 200, schema: agentTokensPageSchema },
  },
  {
    method: "POST",
    path: "/workspaces/{workspaceId}/agent-tokens",
    operationId: "createAgentToken",
    summary: "Mint a workspace-scoped agent token; secret appears once.",
    auth: "human",
    requestBody: createAgentTokenInputSchema,
    success: { status: 201, schema: agentTokenCreatedSchema },
    successAlt: [200],
  },
  {
    method: "DELETE",
    path: "/workspaces/{workspaceId}/agent-tokens/{tokenId}",
    operationId: "revokeAgentToken",
    summary: "Immediately disable an agent token.",
    auth: "human",
    success: { status: 200, schema: okResponseSchema },
  },
  {
    method: "POST",
    path: "/workspaces/{workspaceId}/commands",
    operationId: "submitCommand",
    summary: "Execute a domain command envelope; always 200 CommandReceipt on success.",
    auth: "member",
    requestBody: commandEnvelopeSchema,
    success: { status: 200, schema: commandReceiptSchema },
  },
  {
    method: "POST",
    path: "/workspaces/{workspaceId}/bootstrap",
    operationId: "startBootstrap",
    summary: "Create or reuse an immutable catalogue snapshot.",
    auth: "member",
    requestBody: bootstrapInputSchema,
    success: { status: 201, schema: bootstrapStartSchema },
    successAlt: [200],
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/bootstrap/{snapshotId}",
    operationId: "getBootstrapPage",
    summary: "One page of an active bootstrap snapshot.",
    auth: "member",
    query: [
      { name: "pageToken", schema: z.string() },
      { name: "limit", schema: pageLimitSchema },
    ],
    success: { status: 200, schema: bootstrapPageSchema },
  },
  {
    method: "GET",
    path: "/workspaces/{workspaceId}/changes",
    operationId: "getChanges",
    summary: "Committed catalogue changes after a cursor, in commit order.",
    auth: "member",
    query: [
      { name: "after", schema: seqSchema, required: true },
      { name: "serverEpoch", schema: idSchema, required: true },
      { name: "membershipGeneration", schema: idSchema, required: true },
      { name: "limit", schema: pageLimitSchema },
    ],
    success: { status: 200, schema: changesPageSchema },
  },
  {
    method: "GET",
    path: "/health/ready",
    operationId: "healthReady",
    summary: "Infrastructure readiness probe; no private data.",
    auth: "infrastructure",
    success: { status: 200, schema: healthReadySchema },
  },
];
