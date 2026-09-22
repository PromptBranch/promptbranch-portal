import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  acceptInvitationInputSchema,
  API_BASE_PATH,
  auditEntrySchema,
  bootstrapInputSchema,
  bootstrapPageSchema,
  bootstrapStartSchema,
  changesPageSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  createAgentTokenInputSchema,
  createWorkspaceInputSchema,
  deleteMeInputSchema,
  EPOCH_HEADER,
  errorBodySchema,
  healthReadySchema,
  meResponseSchema,
  okResponseSchema,
  principalResponseSchema,
  PROTOCOL_HEADER,
  promptDetailResponseSchema,
  promptsPageSchema,
  REQUEST_ID_HEADER,
  revisionResponseSchema,
  revisionsPageSchema,
  tagsPageSchema,
  collectionsPageSchema,
  proposalsPageSchema,
  proposalDetailResponseSchema,
  commentsPageSchema,
  activityItemsPageSchema,
  membersPageSchema,
  invitationsPageSchema,
  auditPageSchema,
  sessionsPageSchema,
  agentTokensPageSchema,
  agentTokenCreatedSchema,
  teamInfoSchema,
  workspaceResponseSchema,
  workspacesPageSchema,
  type Actor,
  type ActivityItem,
  type Change,
  type Collection,
  type Comment,
  type Proposal,
  type Revision,
  type Review,
  type Role,
  type Scope,
  type Tag,
  type TeamInfo,
  type TeamOperation,
  type Workspace,
} from "../index.js";
import { fixtures, type CatalogSeedFixture } from "./fixtures.js";
import { z } from "zod";

/**
 * Loopback-only PB-TEAM-1 mock with synthetic bearer tokens (C9). It exists so
 * both repositories can develop against the contract without a real Portal;
 * it is never deployable auth. Outgoing responses are validated against the
 * contract schemas before they are sent, except when a deliberately injected
 * fault produces a non-conformant payload.
 */
export const MOCK_TOKENS = {
  owner: "pbtest_owner",
  maintainer: "pbtest_maintainer",
  contributor: "pbtest_contributor",
  viewer: "pbtest_viewer",
  outsider: "pbtest_outsider",
  agent: "pbtest_agent",
} as const;

export const MOCK_FAULTS = [
  "drop-response-after-commit",
  "stale-base",
  "revoked-member",
  "expired-bootstrap",
  "unknown-feed-event",
] as const;
export type MockFault = (typeof MOCK_FAULTS)[number];
export const MOCK_FAULT_HEADER = "x-promptbranch-team-mock-fault";

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 262144;

interface MockUser {
  id: string;
  displayName: string;
  email: string;
  bearerToken: string;
  anonymized: boolean;
}

interface MockAgentToken {
  id: string;
  name: string;
  userId: string;
  scopes: Scope[];
  bearerToken: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

interface MockInvitation {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "accepted" | "revoked";
  expiresAt: string;
  token: string;
}

interface WorkspaceState {
  id: string;
  name: string;
  entityVersion: number;
  updatedAt: string;
  deleted: boolean;
  members: Map<string, { role: Role; entityVersion: number }>;
  prompts: Map<string, import("../index.js").Prompt>;
  revisions: Map<string, Revision>;
  candidates: Map<string, Revision>;
  tags: Map<string, Tag>;
  collections: Map<string, Collection>;
  proposals: Map<string, Proposal>;
  reviews: Review[];
  comments: Comment[];
  activity: ActivityItem[];
  changes: Change[];
  seq: number;
  invitations: Map<string, MockInvitation>;
  agentTokens: Map<string, MockAgentToken>;
  audit: {
    id: string;
    actor: Actor;
    action: string;
    resourceType: string;
    resourceId: string;
    createdAt: string;
  }[];
}

interface Snapshot {
  id: string;
  workspaceId: string;
  principalId: string;
  membershipGeneration: string;
  serverEpoch: string;
  highWater: string;
  records: unknown[];
  expiresAtMs: number;
}

interface MockSession {
  id: string;
  userId: string;
  clientId: string;
  createdAt: string;
  revokedAt: string | null;
}

interface Caller {
  kind: "human" | "agent";
  user: MockUser;
  agentToken: MockAgentToken | null;
  principalId: string;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  seed?: CatalogSeedFixture;
  faults?: readonly MockFault[];
}

export interface MockServerHandle {
  origin: string;
  close: () => Promise<void>;
  state: {
    readonly proposalCount: number;
    readonly receiptCount: number;
  };
  [Symbol.asyncDispose]: () => Promise<void>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  contributor: 1,
  maintainer: 2,
  owner: 3,
};

function roleAtLeast(role: Role | null, minimum: Role): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function createMockServer(
  options: MockServerOptions = {},
): Promise<MockServerHandle> {
  const seed = options.seed ?? fixtures.catalogSeed;
  const alwaysFaults = new Set<MockFault>(options.faults ?? []);
  const info: TeamInfo = seed.server;

  const users = new Map<string, MockUser>();
  const tokensToUser = new Map<string, MockUser>();
  for (const entry of seed.users) {
    const user: MockUser = {
      id: entry.id,
      displayName: entry.displayName,
      email: entry.email,
      bearerToken: entry.bearerToken,
      anonymized: false,
    };
    users.set(user.id, user);
    tokensToUser.set(user.bearerToken, user);
  }

  const workspace: WorkspaceState = {
    id: seed.workspace.id,
    name: seed.workspace.name,
    entityVersion: seed.workspace.entityVersion,
    updatedAt: seed.workspace.updatedAt,
    deleted: false,
    members: new Map(),
    prompts: new Map(),
    revisions: new Map(),
    candidates: new Map(),
    tags: new Map(),
    collections: new Map(),
    proposals: new Map(),
    reviews: [],
    comments: [],
    activity: [],
    changes: [],
    seq: Number(fixtures.catalogChanges.baseSeq),
    invitations: new Map(),
    agentTokens: new Map(),
    audit: [],
  };
  const workspaces = new Map<string, WorkspaceState>([[workspace.id, workspace]]);
  for (const entry of seed.users) {
    if (entry.role) {
      workspace.members.set(entry.id, { role: entry.role, entityVersion: 1 });
    }
  }
  for (const tag of seed.tags) workspace.tags.set(tag.id, { ...tag });
  for (const collection of seed.collections) {
    workspace.collections.set(collection.id, { ...collection });
  }
  for (const { prompt, revisions } of seed.prompts) {
    workspace.prompts.set(prompt.id, { ...prompt });
    for (const revision of revisions) workspace.revisions.set(revision.id, { ...revision });
  }
  for (const token of seed.agentTokens) {
    workspace.agentTokens.set(token.id, {
      id: token.id,
      name: token.name,
      userId: token.ownerUserId,
      scopes: [...token.scopes],
      bearerToken: token.bearerToken,
      expiresAt: token.expiresAt,
      createdAt: token.expiresAt,
      revokedAt: null,
    });
  }

  const sessions = new Map<string, MockSession>();
  for (const user of users.values()) {
    sessions.set(user.id, {
      id: randomUUID(),
      userId: user.id,
      clientId: "promptbranch-desktop",
      createdAt: seed.workspace.updatedAt,
      revokedAt: null,
    });
  }

  const receipts = new Map<string, { requestHash: string; status: number; body: unknown }>();
  const snapshots = new Map<string, Snapshot>();

  function actor(caller: Caller): Actor {
    return {
      userId: caller.user.id,
      displayName: caller.user.displayName,
      agentTokenId: caller.agentToken?.id ?? null,
    };
  }

  function authenticate(req: IncomingMessage): Caller | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const user = tokensToUser.get(token);
    if (user) {
      const session = sessions.get(user.id);
      if (session?.revokedAt) return null;
      if (user.anonymized) return null;
      return { kind: "human", user, agentToken: null, principalId: `human:${user.id}` };
    }
    for (const ws of workspaces.values()) {
      for (const agentToken of ws.agentTokens.values()) {
        if (agentToken.bearerToken === token && !agentToken.revokedAt) {
          const owner = users.get(agentToken.userId);
          if (!owner || !ws.members.has(owner.id) || owner.anonymized) return null;
          return {
            kind: "agent",
            user: owner,
            agentToken,
            principalId: `agent:${agentToken.id}`,
          };
        }
      }
    }
    return null;
  }

  function membership(ws: WorkspaceState, caller: Caller): Role | null {
    return ws.members.get(caller.user.id)?.role ?? null;
  }

  function agentHasScope(caller: Caller, scope: Scope): boolean {
    return caller.kind === "agent" && (caller.agentToken?.scopes.includes(scope) ?? false);
  }

  function sendError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ): void {
    sendValidated(res, status, errorBodySchema, {
      error: {
        code,
        message,
        requestId: randomUUID(),
        retryable,
        ...(details ? { details } : {}),
      },
    });
  }

  function sendValidated(
    res: ServerResponse,
    status: number,
    schema: z.ZodType,
    body: unknown,
  ): void {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const payload = JSON.stringify({
        error: {
          code: "MOCK_RESPONSE_INVALID",
          message: `mock produced a non-contract response: ${parsed.error.issues[0]?.message ?? "unknown"}`,
          requestId: randomUUID(),
          retryable: false,
        },
      });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(payload);
      return;
    }
    sendRaw(res, status, JSON.stringify(parsed.data));
  }

  function sendRaw(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      vary: "Cookie, Authorization",
      "x-content-type-options": "nosniff",
      [REQUEST_ID_HEADER.toLowerCase()]: randomUUID(),
    });
    res.end(body);
  }

  function workspaceDto(ws: WorkspaceState, role: Role): Workspace {
    return {
      id: ws.id,
      name: ws.name,
      role,
      membershipGeneration: currentGeneration,
      serverEpoch: info.serverEpoch,
      entityVersion: ws.entityVersion,
      updatedAt: ws.updatedAt,
    };
  }

  function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; nextPageToken: string | null } {
    const limitRaw = query.get("limit");
    const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw Object.assign(new Error("invalid limit"), { mockStatus: 422 });
    }
    let offset = 0;
    const token = query.get("pageToken");
    if (token) {
      try {
        offset = (JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { o: number }).o;
      } catch {
        throw Object.assign(new Error("invalid pageToken"), { mockStatus: 422 });
      }
    }
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      items: page,
      nextPageToken:
        nextOffset < items.length
          ? Buffer.from(JSON.stringify({ o: nextOffset }), "utf8").toString("base64url")
          : null,
    };
  }

  function sortedById<T extends { id: string }>(items: Iterable<T>): T[] {
    return [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  let currentGeneration = seed.workspace.membershipGeneration;

  function rotateGeneration(): void {
    currentGeneration = randomUUID();
  }

  function recordAudit(ws: WorkspaceState, caller: Caller, action: string, resourceType: string, resourceId: string): void {
    ws.audit.push({
      id: randomUUID(),
      actor: actor(caller),
      action,
      resourceType,
      resourceId,
      createdAt: nowIso(),
    });
  }

  function pushChange(ws: WorkspaceState, records: Change["records"], tombstones: Change["tombstones"]): void {
    ws.seq += 1;
    ws.changes.push({ seq: String(ws.seq), records, tombstones });
  }

  function touchWorkspace(ws: WorkspaceState): void {
    ws.updatedAt = nowIso();
  }

  function requireWorkspaceRole(
    ws: WorkspaceState,
    caller: Caller,
    minimum: Role,
    res: ServerResponse,
  ): boolean {
    const role = membership(ws, caller);
    if (!role) {
      sendError(res, 403, "WORKSPACE_FORBIDDEN", "You do not have access to this workspace.");
      return false;
    }
    if (!roleAtLeast(role, minimum)) {
      sendError(res, 403, "ROLE_FORBIDDEN", "Your workspace role does not permit this action.");
      return false;
    }
    return true;
  }

  function refuseAgent(res: ServerResponse): void {
    sendError(res, 403, "SCOPE_FORBIDDEN", "This agent token lacks the scope required for this action.");
  }

  function executeOperation(
    ws: WorkspaceState,
    caller: Caller,
    operation: TeamOperation,
    res: ServerResponse,
  ): { kind: string; id: string; entityVersion?: number } | null {
    const role = membership(ws, caller);
    const human = caller.kind === "human";
    switch (operation.type) {
      case "prompt.create": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const promptId = randomUUID();
        const revisionId = randomUUID();
        const created = nowIso();
        const prompt: import("../index.js").Prompt = {
          id: promptId,
          workspaceId: ws.id,
          title: operation.title,
          description: operation.description,
          approvedRevisionId: revisionId,
          tagIds: operation.tagIds,
          collectionIds: operation.collectionIds,
          entityVersion: 1,
          archivedAt: null,
          createdAt: created,
          updatedAt: created,
        };
        const revision: Revision = {
          id: revisionId,
          workspaceId: ws.id,
          promptId,
          parentRevisionId: null,
          content: operation.content,
          contentFormat: "markdown",
          contentHash: sha256Hex(operation.content),
          changeNote: operation.changeNote,
          author: actor(caller),
          createdAt: created,
        };
        ws.prompts.set(promptId, prompt);
        ws.revisions.set(revisionId, revision);
        recordAudit(ws, caller, "prompt.create", "prompt", promptId);
        pushChange(ws, [
          { entity: "prompt", value: prompt },
          { entity: "revision", value: revision },
        ], []);
        return { kind: "prompt", id: promptId, entityVersion: 1 };
      }
      case "prompt.metadata": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const prompt = ws.prompts.get(operation.promptId);
        if (!prompt) return sendError(res, 404, "NOT_FOUND", "Unknown prompt."), null;
        if (prompt.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The entity version does not match.");
          return null;
        }
        prompt.title = operation.title;
        prompt.description = operation.description;
        prompt.tagIds = operation.tagIds;
        prompt.collectionIds = operation.collectionIds;
        prompt.entityVersion += 1;
        prompt.updatedAt = nowIso();
        recordAudit(ws, caller, "prompt.metadata", "prompt", prompt.id);
        pushChange(ws, [{ entity: "prompt", value: { ...prompt } }], []);
        return { kind: "prompt", id: prompt.id, entityVersion: prompt.entityVersion };
      }
      case "prompt.archive":
      case "prompt.restore": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const prompt = ws.prompts.get(operation.promptId);
        if (!prompt) return sendError(res, 404, "NOT_FOUND", "Unknown prompt."), null;
        if (prompt.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The entity version does not match.");
          return null;
        }
        prompt.archivedAt = operation.type === "prompt.archive" ? nowIso() : null;
        prompt.entityVersion += 1;
        prompt.updatedAt = nowIso();
        recordAudit(ws, caller, operation.type, "prompt", prompt.id);
        pushChange(ws, [{ entity: "prompt", value: { ...prompt } }], []);
        return { kind: "prompt", id: prompt.id, entityVersion: prompt.entityVersion };
      }
      case "prompt.rollback": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const prompt = ws.prompts.get(operation.promptId);
        if (!prompt) return sendError(res, 404, "NOT_FOUND", "Unknown prompt."), null;
        const target = ws.revisions.get(operation.targetRevisionId);
        if (!target || target.promptId !== prompt.id) {
          sendError(res, 422, "VALIDATION_FAILED", "Target is not a published revision of this prompt.");
          return null;
        }
        if (prompt.approvedRevisionId !== operation.expectedApprovedRevisionId) {
          sendError(res, 409, "STALE_BASE", "The approved head moved.");
          return null;
        }
        prompt.approvedRevisionId = target.id;
        prompt.entityVersion += 1;
        prompt.updatedAt = nowIso();
        recordAudit(ws, caller, "prompt.rollback", "prompt", prompt.id);
        pushChange(ws, [{ entity: "prompt", value: { ...prompt } }], []);
        return { kind: "prompt", id: prompt.id, entityVersion: prompt.entityVersion };
      }
      case "proposal.submit": {
        if (!human && !agentHasScope(caller, "proposal:write")) return refuseAgent(res), null;
        if (!roleAtLeast(role, "contributor")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
          return null;
        }
        const prompt = ws.prompts.get(operation.promptId);
        if (!prompt) return sendError(res, 404, "NOT_FOUND", "Unknown prompt."), null;
        if (prompt.archivedAt) {
          sendError(res, 409, "STALE_ENTITY", "The prompt is archived.");
          return null;
        }
        const base = ws.revisions.get(operation.baseRevisionId);
        if (!base || base.promptId !== prompt.id) {
          sendError(res, 422, "VALIDATION_FAILED", "Base is not a published revision of this prompt.");
          return null;
        }
        if (operation.supersedesProposalId) {
          const previous = ws.proposals.get(operation.supersedesProposalId);
          if (!previous) return sendError(res, 404, "NOT_FOUND", "Unknown proposal."), null;
          if (previous.author.userId !== caller.user.id) {
            sendError(res, 403, "ROLE_FORBIDDEN", "Only the author can supersede a proposal.");
            return null;
          }
          if (previous.status !== "open") {
            sendError(res, 409, "STALE_ENTITY", "The proposal is no longer open.");
            return null;
          }
          previous.status = "superseded";
          previous.entityVersion += 1;
          previous.updatedAt = nowIso();
        }
        const candidateId = randomUUID();
        const candidate: Revision = {
          id: candidateId,
          workspaceId: ws.id,
          promptId: prompt.id,
          parentRevisionId: operation.baseRevisionId,
          content: operation.content,
          contentFormat: "markdown",
          contentHash: sha256Hex(operation.content),
          changeNote: operation.rationale,
          author: actor(caller),
          createdAt: nowIso(),
        };
        const proposal: Proposal = {
          id: randomUUID(),
          workspaceId: ws.id,
          promptId: prompt.id,
          baseRevisionId: operation.baseRevisionId,
          candidateRevisionId: candidateId,
          rationale: operation.rationale,
          author: actor(caller),
          status: "open",
          supersedesProposalId: operation.supersedesProposalId,
          entityVersion: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        ws.candidates.set(candidateId, candidate);
        ws.proposals.set(proposal.id, proposal);
        recordAudit(ws, caller, "proposal.submit", "proposal", proposal.id);
        return { kind: "proposal", id: proposal.id, entityVersion: 1 };
      }
      case "proposal.withdraw": {
        // C1: withdrawing is part of the proposal:write capability for agents.
        if (!human && !agentHasScope(caller, "proposal:write")) return refuseAgent(res), null;
        const proposal = ws.proposals.get(operation.proposalId);
        if (!proposal) return sendError(res, 404, "NOT_FOUND", "Unknown proposal."), null;
        const isAuthor =
          proposal.author.userId === caller.user.id &&
          (human || proposal.author.agentTokenId === caller.agentToken?.id);
        if (!isAuthor) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Only the author can withdraw a proposal.");
          return null;
        }
        if (proposal.status !== "open" || proposal.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The proposal changed or is already terminal.");
          return null;
        }
        proposal.status = "withdrawn";
        proposal.entityVersion += 1;
        proposal.updatedAt = nowIso();
        recordAudit(ws, caller, "proposal.withdraw", "proposal", proposal.id);
        return { kind: "proposal", id: proposal.id, entityVersion: proposal.entityVersion };
      }
      case "proposal.review": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const proposal = ws.proposals.get(operation.proposalId);
        if (!proposal) return sendError(res, 404, "NOT_FOUND", "Unknown proposal."), null;
        if (proposal.author.userId === caller.user.id) {
          sendError(res, 409, "SELF_REVIEW", "A proposal cannot be reviewed by its own author.");
          return null;
        }
        if (proposal.status !== "open") {
          sendError(res, 409, "STALE_ENTITY", "The proposal is already terminal.");
          return null;
        }
        if (proposal.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The proposal version does not match.");
          return null;
        }
        const candidate = ws.candidates.get(proposal.candidateRevisionId);
        if (
          operation.candidateRevisionId !== proposal.candidateRevisionId ||
          !candidate ||
          candidate.contentHash !== operation.candidateContentHash
        ) {
          sendError(res, 422, "VALIDATION_FAILED", "Candidate identity or hash does not match.");
          return null;
        }
        const prompt = ws.prompts.get(proposal.promptId);
        if (!prompt) return sendError(res, 404, "NOT_FOUND", "Unknown prompt."), null;
        if (operation.decision === "approve" && prompt.archivedAt) {
          // C3: approval on an archived prompt is STALE_ENTITY, not STALE_BASE.
          sendError(res, 409, "STALE_ENTITY", "The prompt is archived.");
          return null;
        }
        const review: Review = {
          id: randomUUID(),
          proposalId: proposal.id,
          candidateRevisionId: candidate.id,
          candidateContentHash: candidate.contentHash,
          reviewer: actor(caller),
          decision: operation.decision,
          comment: operation.comment,
          createdAt: nowIso(),
        };
        if (operation.decision === "approve") {
          if (
            prompt.archivedAt ||
            prompt.approvedRevisionId !== operation.expectedApprovedRevisionId ||
            proposal.baseRevisionId !== operation.expectedApprovedRevisionId
          ) {
            sendError(res, 409, "STALE_BASE", "The approved head moved since this proposal was based on it.");
            return null;
          }
          ws.revisions.set(candidate.id, candidate);
          ws.candidates.delete(candidate.id);
          prompt.approvedRevisionId = candidate.id;
          prompt.entityVersion += 1;
          prompt.updatedAt = nowIso();
          proposal.status = "approved";
          pushChange(ws, [
            { entity: "prompt", value: { ...prompt } },
            { entity: "revision", value: { ...candidate } },
          ], []);
        } else {
          proposal.status = "rejected";
        }
        proposal.entityVersion += 1;
        proposal.updatedAt = nowIso();
        ws.reviews.push(review);
        recordAudit(ws, caller, `proposal.${operation.decision}`, "proposal", proposal.id);
        return { kind: "review", id: review.id };
      }
      case "comment.add": {
        if (!human && !agentHasScope(caller, "proposal:write")) return refuseAgent(res), null;
        if (!roleAtLeast(role, "contributor")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
          return null;
        }
        const proposal = ws.proposals.get(operation.proposalId);
        if (!proposal) return sendError(res, 404, "NOT_FOUND", "Unknown proposal."), null;
        // C1: proposal:write permits commenting only on the token's own proposals.
        if (!human && proposal.author.agentTokenId !== caller.agentToken?.id) {
          return refuseAgent(res), null;
        }
        const comment: Comment = {
          id: randomUUID(),
          proposalId: proposal.id,
          body: operation.body,
          author: actor(caller),
          createdAt: nowIso(),
        };
        ws.comments.push(comment);
        return { kind: "comment", id: comment.id };
      }
      case "note.add":
      case "run.report": {
        const scope: Scope = operation.type === "note.add" ? "note:write" : "run:write";
        if (!human && !agentHasScope(caller, scope)) return refuseAgent(res), null;
        if (!roleAtLeast(role, "contributor")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
          return null;
        }
        const revision = ws.revisions.get(operation.revisionId);
        if (!revision || revision.promptId !== operation.promptId) {
          sendError(res, 422, "VALIDATION_FAILED", "Revision is not published on this prompt.");
          return null;
        }
        const item: ActivityItem = {
          id: randomUUID(),
          workspaceId: ws.id,
          promptId: operation.promptId,
          revisionId: operation.revisionId,
          author: actor(caller),
          kind: operation.type === "note.add" ? "note" : "run",
          body: operation.body,
          createdAt: nowIso(),
          run:
            operation.type === "run.report"
              ? {
                  model: operation.model,
                  status: operation.status,
                  latencyMs: operation.latencyMs,
                  inputTokens: operation.inputTokens,
                  outputTokens: operation.outputTokens,
                  estimatedCostUsd: operation.estimatedCostUsd,
                }
              : null,
        };
        ws.activity.push(item);
        return { kind: "activityItem", id: item.id };
      }
      case "tag.create":
      case "collection.create": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const isTag = operation.type === "tag.create";
        const registry = isTag ? ws.tags : ws.collections;
        const wanted = operation.name.trim().toLowerCase();
        for (const existing of registry.values()) {
          if (existing.name.trim().toLowerCase() === wanted) {
            sendError(res, 422, "VALIDATION_FAILED", "Name already exists in this workspace.");
            return null;
          }
        }
        const id = randomUUID();
        const entity = { id, workspaceId: ws.id, name: operation.name, entityVersion: 1 };
        registry.set(id, entity as Tag & Collection);
        recordAudit(ws, caller, operation.type, isTag ? "tag" : "collection", id);
        pushChange(
          ws,
          [{ entity: isTag ? "tag" : "collection", value: { ...entity } } as Change["records"][number]],
          [],
        );
        return { kind: isTag ? "tag" : "collection", id, entityVersion: 1 };
      }
      case "tag.rename":
      case "collection.rename": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const isTag = operation.type === "tag.rename";
        const registry = isTag ? ws.tags : ws.collections;
        const entity = registry.get(operation.id);
        if (!entity) return sendError(res, 404, "NOT_FOUND", "Unknown entity."), null;
        if (entity.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The entity version does not match.");
          return null;
        }
        entity.name = operation.name;
        entity.entityVersion += 1;
        recordAudit(ws, caller, operation.type, isTag ? "tag" : "collection", entity.id);
        pushChange(
          ws,
          [{ entity: isTag ? "tag" : "collection", value: { ...entity } } as Change["records"][number]],
          [],
        );
        return { kind: isTag ? "tag" : "collection", id: entity.id, entityVersion: entity.entityVersion };
      }
      case "tag.delete":
      case "collection.delete": {
        if (!human) return refuseAgent(res), null;
        if (!roleAtLeast(role, "maintainer")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Maintainer role required.");
          return null;
        }
        const isTag = operation.type === "tag.delete";
        const registry = isTag ? ws.tags : ws.collections;
        const entity = registry.get(operation.id);
        if (!entity) return sendError(res, 404, "NOT_FOUND", "Unknown entity."), null;
        if (entity.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The entity version does not match.");
          return null;
        }
        registry.delete(operation.id);
        const affected: Change["records"] = [];
        for (const prompt of ws.prompts.values()) {
          const before = isTag ? prompt.tagIds : prompt.collectionIds;
          if (before.includes(operation.id)) {
            if (isTag) prompt.tagIds = prompt.tagIds.filter((id) => id !== operation.id);
            else prompt.collectionIds = prompt.collectionIds.filter((id) => id !== operation.id);
            prompt.entityVersion += 1;
            prompt.updatedAt = nowIso();
            affected.push({ entity: "prompt", value: { ...prompt } });
          }
        }
        recordAudit(ws, caller, operation.type, isTag ? "tag" : "collection", operation.id);
        pushChange(ws, affected, [
          { entity: isTag ? "tag" : "collection", id: operation.id },
        ]);
        return { kind: isTag ? "tag" : "collection", id: operation.id };
      }
      case "invitation.create": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        const invitation: MockInvitation = {
          id: randomUUID(),
          email: operation.email,
          role: operation.role,
          status: "pending",
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          token: randomUUID(),
        };
        ws.invitations.set(invitation.id, invitation);
        recordAudit(ws, caller, "invitation.create", "invitation", invitation.id);
        return { kind: "invitation", id: invitation.id };
      }
      case "invitation.revoke": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        const invitation = ws.invitations.get(operation.invitationId);
        if (!invitation) return sendError(res, 404, "NOT_FOUND", "Unknown invitation."), null;
        invitation.status = "revoked";
        recordAudit(ws, caller, "invitation.revoke", "invitation", invitation.id);
        return { kind: "invitation", id: invitation.id };
      }
      case "member.role": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        const target = ws.members.get(operation.userId);
        if (!target) return sendError(res, 404, "NOT_FOUND", "Unknown member."), null;
        if (target.role === "owner" && operation.role !== "owner") {
          const owners = [...ws.members.values()].filter((m) => m.role === "owner").length;
          if (owners <= 1) {
            sendError(res, 409, "LAST_OWNER", "The last owner cannot be demoted.");
            return null;
          }
        }
        target.role = operation.role;
        target.entityVersion += 1;
        rotateGeneration();
        recordAudit(ws, caller, "member.role", "member", operation.userId);
        return { kind: "member", id: operation.userId, entityVersion: target.entityVersion };
      }
      case "member.remove": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        const target = ws.members.get(operation.userId);
        if (!target) return sendError(res, 404, "NOT_FOUND", "Unknown member."), null;
        if (target.role === "owner") {
          const owners = [...ws.members.values()].filter((m) => m.role === "owner").length;
          if (owners <= 1) {
            sendError(res, 409, "LAST_OWNER", "The last owner cannot be removed.");
            return null;
          }
        }
        ws.members.delete(operation.userId);
        for (const token of ws.agentTokens.values()) {
          if (token.userId === operation.userId) token.revokedAt = nowIso();
        }
        rotateGeneration();
        recordAudit(ws, caller, "member.remove", "member", operation.userId);
        return { kind: "member", id: operation.userId };
      }
      case "workspace.rename": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        if (ws.entityVersion !== operation.expectedEntityVersion) {
          sendError(res, 409, "STALE_ENTITY", "The entity version does not match.");
          return null;
        }
        ws.name = operation.name;
        ws.entityVersion += 1;
        touchWorkspace(ws);
        recordAudit(ws, caller, "workspace.rename", "workspace", ws.id);
        return { kind: "workspace", id: ws.id, entityVersion: ws.entityVersion };
      }
      case "workspace.delete": {
        if (!human) return refuseAgent(res), null;
        if (role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
          return null;
        }
        if (operation.confirmName !== ws.name) {
          sendError(res, 422, "VALIDATION_FAILED", "confirmName does not match the workspace name.");
          return null;
        }
        ws.deleted = true;
        recordAudit(ws, caller, "workspace.delete", "workspace", ws.id);
        return { kind: "workspace", id: ws.id };
      }
    }
  }

  function handleCommand(ws: WorkspaceState, caller: Caller, faults: Set<MockFault>, body: unknown, req: IncomingMessage, res: ServerResponse): void {
    if (req.headers[EPOCH_HEADER.toLowerCase()] !== info.serverEpoch) {
      sendError(res, 410, "SERVER_EPOCH_CHANGED", "The server epoch changed; bootstrap again.");
      return;
    }
    const parsed = commandEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      sendError(res, 422, "VALIDATION_FAILED", "The command envelope failed validation.", false, {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return;
    }
    const envelope = parsed.data;
    if (envelope.membershipGeneration !== currentGeneration) {
      sendError(res, 409, "MEMBERSHIP_CHANGED", "Your membership generation changed; re-sync before writing.");
      return;
    }
    const receiptKey = `${ws.id}:${caller.principalId}:${envelope.commandId}`;
    const requestHash = sha256Hex(stableStringify(envelope));
    const existing = receipts.get(receiptKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        sendError(res, 409, "COMMAND_ID_REUSED", "This command id was already used with a different request.");
        return;
      }
      sendValidated(res, 200, commandReceiptSchema, existing.body);
      return;
    }
    if (faults.has("stale-base") && envelope.operation.type === "proposal.review") {
      sendError(res, 409, "STALE_BASE", "Injected fault: stale base.");
      return;
    }
    const result = executeOperation(ws, caller, envelope.operation, res);
    if (!result) return; // executeOperation already sent an error
    const receipt = {
      commandId: envelope.commandId,
      committedAt: nowIso(),
      catalogSeq: String(ws.seq),
      result,
    };
    receipts.set(receiptKey, { requestHash, status: 200, body: receipt });
    if (faults.has("drop-response-after-commit")) {
      // Commit happened; the response is lost on the wire.
      req.socket.destroy();
      return;
    }
    sendValidated(res, 200, commandReceiptSchema, receipt);
  }

  function catalogueRecords(ws: WorkspaceState): Change["records"] {
    const records: Change["records"] = [];
    for (const tag of sortedById(ws.tags.values())) records.push({ entity: "tag", value: tag });
    for (const collection of sortedById(ws.collections.values())) {
      records.push({ entity: "collection", value: collection });
    }
    for (const prompt of sortedById(ws.prompts.values())) records.push({ entity: "prompt", value: prompt });
    for (const revision of sortedById(ws.revisions.values())) {
      records.push({ entity: "revision", value: revision });
    }
    return records;
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        throw Object.assign(new Error("payload too large"), { mockStatus: 413 });
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid JSON"), { mockStatus: 422 });
    }
  }


  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const faults = new Set<MockFault>(alwaysFaults);
    const faultHeader = req.headers[MOCK_FAULT_HEADER];
    if (typeof faultHeader === "string" && (MOCK_FAULTS as readonly string[]).includes(faultHeader)) {
      faults.add(faultHeader as MockFault);
    }

    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === `${API_BASE_PATH}/info` && method === "GET") {
      sendValidated(res, 200, teamInfoSchema, info);
      return;
    }
    if (path === `${API_BASE_PATH}/health/ready` && method === "GET") {
      sendValidated(res, 200, healthReadySchema, { ready: true });
      return;
    }
    if (!path.startsWith(`${API_BASE_PATH}/`)) {
      sendError(res, 404, "NOT_FOUND", "Unknown route.");
      return;
    }
    if (req.headers[PROTOCOL_HEADER.toLowerCase()] !== "1") {
      sendError(res, 426, "PROTOCOL_UNSUPPORTED", "This server requires team protocol 1.");
      return;
    }
    const caller = authenticate(req);
    if (!caller) {
      sendError(res, 401, "UNAUTHENTICATED", "A valid bearer token or web session is required.");
      return;
    }

    const body = method === "POST" || method === "DELETE" ? await readBody(req) : undefined;
    const segments = path.slice(API_BASE_PATH.length + 1).split("/");

    // Account-level routes.
    if (segments[0] === "me" && segments.length === 1) {
      if (caller.kind !== "human") return refuseAgent(res);
      if (method === "GET") {
        const memberships = [...workspaces.values()]
          .filter((ws) => !ws.deleted && ws.members.has(caller.user.id))
          .map((ws) => workspaceDto(ws, ws.members.get(caller.user.id)!.role));
        sendValidated(res, 200, meResponseSchema, {
          user: {
            id: caller.user.id,
            displayName: caller.user.displayName,
            email: caller.user.email,
          },
          workspaces: memberships,
        });
        return;
      }
      if (method === "DELETE") {
        const parsed = deleteMeInputSchema.safeParse(body);
        if (!parsed.success || parsed.data.confirmEmail !== caller.user.email) {
          sendError(res, 422, "VALIDATION_FAILED", "confirmEmail does not match the account email.");
          return;
        }
        caller.user.anonymized = true;
        caller.user.displayName = "Former member";
        for (const ws of workspaces.values()) {
          ws.members.delete(caller.user.id);
          for (const token of ws.agentTokens.values()) {
            if (token.userId === caller.user.id) token.revokedAt = nowIso();
          }
        }
        sendValidated(res, 200, okResponseSchema, { ok: true });
        return;
      }
    }
    if (segments[0] === "principal" && method === "GET") {
      sendValidated(res, 200, principalResponseSchema, {
        kind: caller.kind,
        principalId: caller.principalId,
        userId: caller.user.id,
        agentTokenId: caller.agentToken?.id ?? null,
        scopes: caller.kind === "agent" ? caller.agentToken!.scopes : [],
      });
      return;
    }
    if (segments[0] === "sessions") {
      if (caller.kind !== "human") return refuseAgent(res);
      if (segments.length === 1 && method === "GET") {
        const own = [...sessions.values()].filter((s) => s.userId === caller.user.id);
        sendValidated(res, 200, sessionsPageSchema, {
          items: own.map((s) => ({
            id: s.id,
            clientId: s.clientId,
            createdAt: s.createdAt,
            lastSeenAt: nowIso(),
            revokedAt: s.revokedAt,
          })),
          nextPageToken: null,
        });
        return;
      }
      if (segments.length === 2 && method === "DELETE") {
        const session = [...sessions.values()].find((s) => s.id === segments[1]);
        if (!session || session.userId !== caller.user.id) {
          sendError(res, 404, "NOT_FOUND", "Unknown session.");
          return;
        }
        session.revokedAt = nowIso();
        sendValidated(res, 200, okResponseSchema, { ok: true });
        return;
      }
      if (segments[1] === "revoke-all" && method === "POST") {
        for (const session of sessions.values()) {
          if (session.userId === caller.user.id) session.revokedAt = nowIso();
        }
        for (const ws of workspaces.values()) {
          for (const token of ws.agentTokens.values()) {
            if (token.userId === caller.user.id) token.revokedAt = nowIso();
          }
        }
        sendValidated(res, 200, okResponseSchema, { ok: true });
        return;
      }
    }
    if (segments[0] === "invitations" && segments[1] === "accept" && method === "POST") {
      if (caller.kind !== "human") return refuseAgent(res);
      const parsed = acceptInvitationInputSchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 422, "VALIDATION_FAILED", "Invalid invitation acceptance.");
        return;
      }
      const receiptKey = `user:${caller.principalId}:${parsed.data.commandId}`;
      const requestHash = sha256Hex(stableStringify(parsed.data));
      const existing = receipts.get(receiptKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          sendError(res, 409, "COMMAND_ID_REUSED", "This command id was already used with a different request.");
          return;
        }
        sendValidated(res, existing.status, workspaceResponseSchema, existing.body);
        return;
      }
      let accepted: Workspace | null = null;
      for (const ws of workspaces.values()) {
        for (const invitation of ws.invitations.values()) {
          if (
            invitation.token === parsed.data.token &&
            invitation.status === "pending" &&
            invitation.email.toLowerCase() === caller.user.email.toLowerCase()
          ) {
            invitation.status = "accepted";
            ws.members.set(caller.user.id, { role: invitation.role, entityVersion: 1 });
            rotateGeneration();
            accepted = workspaceDto(ws, invitation.role);
          }
        }
      }
      if (!accepted) {
        sendError(res, 404, "NOT_FOUND", "Unknown or inapplicable invitation.");
        return;
      }
      const responseBody = { workspace: accepted };
      receipts.set(receiptKey, { requestHash, status: 200, body: responseBody });
      sendValidated(res, 200, workspaceResponseSchema, responseBody);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 1) {
      if (method === "GET") {
        if (caller.kind === "agent") {
          const ws = [...workspaces.values()].find((w) => w.agentTokens.has(caller.agentToken!.id));
          sendValidated(res, 200, workspacesPageSchema, {
            items: ws && ws.members.has(caller.user.id)
              ? [workspaceDto(ws, ws.members.get(caller.user.id)!.role)]
              : [],
            nextPageToken: null,
          });
          return;
        }
        const memberships = [...workspaces.values()]
          .filter((ws) => !ws.deleted && ws.members.has(caller.user.id))
          .map((ws) => workspaceDto(ws, ws.members.get(caller.user.id)!.role));
        sendValidated(res, 200, workspacesPageSchema, { items: memberships, nextPageToken: null });
        return;
      }
      if (method === "POST") {
        if (caller.kind !== "human") return refuseAgent(res);
        const parsed = createWorkspaceInputSchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 422, "VALIDATION_FAILED", "Invalid workspace creation input.");
          return;
        }
        const receiptKey = `user:${caller.principalId}:${parsed.data.commandId}`;
        const requestHash = sha256Hex(stableStringify(parsed.data));
        const existing = receipts.get(receiptKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            sendError(res, 409, "COMMAND_ID_REUSED", "This command id was already used with a different request.");
            return;
          }
          sendValidated(res, 200, workspaceResponseSchema, existing.body);
          return;
        }
        const created: WorkspaceState = {
          id: randomUUID(),
          name: parsed.data.name,
          entityVersion: 1,
          updatedAt: nowIso(),
          deleted: false,
          members: new Map([[caller.user.id, { role: "owner" as Role, entityVersion: 1 }]]),
          prompts: new Map(),
          revisions: new Map(),
          candidates: new Map(),
          tags: new Map(),
          collections: new Map(),
          proposals: new Map(),
          reviews: [],
          comments: [],
          activity: [],
          changes: [],
          seq: 0,
          invitations: new Map(),
          agentTokens: new Map(),
          audit: [],
        };
        workspaces.set(created.id, created);
        const responseBody = { workspace: workspaceDto(created, "owner") };
        receipts.set(receiptKey, { requestHash, status: 201, body: responseBody });
        sendValidated(res, 201, workspaceResponseSchema, responseBody);
        return;
      }
    }

    // Workspace-scoped routes.
    if (segments[0] !== "workspaces" || segments.length < 2) {
      sendError(res, 404, "NOT_FOUND", "Unknown route.");
      return;
    }
    const ws = workspaces.get(segments[1]!);
    if (!ws || ws.deleted) {
      sendError(res, 403, "WORKSPACE_FORBIDDEN", "You do not have access to this workspace.");
      return;
    }
    if (faults.has("revoked-member") || !ws.members.has(caller.user.id)) {
      sendError(res, 403, "WORKSPACE_FORBIDDEN", "You do not have access to this workspace.");
      return;
    }
    const sub = segments.slice(2);
    const role = membership(ws, caller);

    if (sub.length === 0 && method === "GET") {
      sendValidated(res, 200, workspaceResponseSchema, { workspace: workspaceDto(ws, role!) });
      return;
    }

    if (sub[0] === "commands" && method === "POST") {
      handleCommand(ws, caller, faults, body, req, res);
      return;
    }

    if (sub[0] === "bootstrap") {
      if (sub.length === 1 && method === "POST") {
        const parsed = bootstrapInputSchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 422, "VALIDATION_FAILED", "Invalid bootstrap input.");
          return;
        }
        if (parsed.data.serverEpoch !== info.serverEpoch) {
          sendError(res, 410, "SERVER_EPOCH_CHANGED", "The server epoch changed.");
          return;
        }
        if (parsed.data.membershipGeneration !== currentGeneration) {
          sendError(res, 409, "MEMBERSHIP_CHANGED", "Your membership generation changed.");
          return;
        }
        for (const snapshot of snapshots.values()) {
          if (
            snapshot.workspaceId === ws.id &&
            snapshot.principalId === caller.principalId &&
            snapshot.membershipGeneration === currentGeneration &&
            snapshot.serverEpoch === info.serverEpoch &&
            snapshot.expiresAtMs > Date.now()
          ) {
            sendValidated(res, 200, bootstrapStartSchema, {
              snapshotId: snapshot.id,
              highWater: snapshot.highWater,
              expiresAt: new Date(snapshot.expiresAtMs).toISOString(),
              serverEpoch: info.serverEpoch,
              membershipGeneration: currentGeneration,
            });
            return;
          }
        }
        const snapshot: Snapshot = {
          id: randomUUID(),
          workspaceId: ws.id,
          principalId: caller.principalId,
          membershipGeneration: currentGeneration,
          serverEpoch: info.serverEpoch,
          highWater: String(ws.seq),
          records: catalogueRecords(ws),
          expiresAtMs: Date.now() + SNAPSHOT_TTL_MS,
        };
        snapshots.set(snapshot.id, snapshot);
        sendValidated(res, 201, bootstrapStartSchema, {
          snapshotId: snapshot.id,
          highWater: snapshot.highWater,
          expiresAt: new Date(snapshot.expiresAtMs).toISOString(),
          serverEpoch: info.serverEpoch,
          membershipGeneration: currentGeneration,
        });
        return;
      }
      if (sub.length === 2 && method === "GET") {
        const snapshot = snapshots.get(sub[1]!);
        if (!snapshot || snapshot.workspaceId !== ws.id) {
          sendError(res, 404, "NOT_FOUND", "Unknown snapshot.");
          return;
        }
        if (faults.has("expired-bootstrap") || snapshot.expiresAtMs <= Date.now()) {
          sendError(res, 410, "SNAPSHOT_EXPIRED", "The bootstrap snapshot expired.");
          return;
        }
        if (snapshot.membershipGeneration !== currentGeneration) {
          sendError(res, 409, "MEMBERSHIP_CHANGED", "Your membership generation changed.");
          return;
        }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
        let offset = 0;
        const token = url.searchParams.get("pageToken");
        if (token) {
          offset = (JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { o: number }).o;
        }
        const page = snapshot.records.slice(offset, offset + limit);
        const nextOffset = offset + limit;
        sendValidated(res, 200, bootstrapPageSchema, {
          snapshotId: snapshot.id,
          records: page,
          nextPageToken:
            nextOffset < snapshot.records.length
              ? Buffer.from(JSON.stringify({ o: nextOffset }), "utf8").toString("base64url")
              : null,
          highWater: snapshot.highWater,
          serverEpoch: info.serverEpoch,
          membershipGeneration: currentGeneration,
        });
        return;
      }
    }

    if (sub[0] === "changes" && method === "GET") {
      const after = url.searchParams.get("after") ?? "";
      if (!/^(0|[1-9][0-9]*)$/.test(after)) {
        sendError(res, 422, "VALIDATION_FAILED", "Malformed cursor.");
        return;
      }
      if (url.searchParams.get("serverEpoch") !== info.serverEpoch) {
        sendError(res, 410, "SERVER_EPOCH_CHANGED", "The server epoch changed.");
        return;
      }
      if (url.searchParams.get("membershipGeneration") !== currentGeneration) {
        sendError(res, 409, "MEMBERSHIP_CHANGED", "Your membership generation changed.");
        return;
      }
      const afterSeq = Number(after);
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
      const matching = ws.changes.filter((change) => Number(change.seq) > afterSeq);
      const page = matching.slice(0, limit);
      const hasMore = matching.length > page.length;
      const body_out: unknown = {
        changes: page,
        nextCursor: page.length > 0 ? page[page.length - 1]!.seq : after,
        hasMore,
        serverEpoch: info.serverEpoch,
        membershipGeneration: currentGeneration,
      };
      if (faults.has("unknown-feed-event")) {
        // Deliberately non-conformant: clients must refuse and pause sync.
        const poisoned = body_out as { changes: unknown[]; nextCursor: string };
        poisoned.changes.push({
          seq: String(Number(poisoned.nextCursor) + 1),
          records: [{ entity: "hologram", value: { id: randomUUID() } }],
          tombstones: [],
        });
        poisoned.nextCursor = String(Number(poisoned.nextCursor) + 1);
        sendRaw(res, 200, JSON.stringify(poisoned));
        return;
      }
      sendValidated(res, 200, changesPageSchema, body_out);
      return;
    }

    if (sub[0] === "prompts") {
      if (sub.length === 1 && method === "GET") {
        let prompts = [...ws.prompts.values()];
        if (url.searchParams.get("archived") !== "true") {
          prompts = prompts.filter((prompt) => !prompt.archivedAt);
        }
        const tagId = url.searchParams.get("tagId");
        if (tagId) prompts = prompts.filter((prompt) => prompt.tagIds.includes(tagId));
        const collectionId = url.searchParams.get("collectionId");
        if (collectionId) {
          prompts = prompts.filter((prompt) => prompt.collectionIds.includes(collectionId));
        }
        const q = url.searchParams.get("q");
        if (q) {
          const needle = q.toLowerCase();
          prompts = prompts.filter((prompt) => {
            const head = ws.revisions.get(prompt.approvedRevisionId);
            const tagNames = prompt.tagIds
              .map((id) => ws.tags.get(id)?.name ?? "")
              .join(" ");
            return [prompt.title, prompt.description, tagNames, head?.content ?? ""]
              .join("\n")
              .toLowerCase()
              .includes(needle);
          });
        }
        prompts.sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
        sendValidated(res, 200, promptsPageSchema, paginate(prompts, url.searchParams));
        return;
      }
      if (sub.length === 2 && method === "GET") {
        const prompt = ws.prompts.get(sub[1]!);
        if (!prompt) {
          sendError(res, 404, "NOT_FOUND", "Unknown prompt.");
          return;
        }
        const revision = ws.revisions.get(prompt.approvedRevisionId)!;
        sendValidated(res, 200, promptDetailResponseSchema, { prompt, revision });
        return;
      }
      if (sub[2] === "revisions" && sub.length === 3 && method === "GET") {
        const prompt = ws.prompts.get(sub[1]!);
        if (!prompt) {
          sendError(res, 404, "NOT_FOUND", "Unknown prompt.");
          return;
        }
        const revisions = [...ws.revisions.values()]
          .filter((revision) => revision.promptId === prompt.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.id < a.id ? -1 : 1));
        sendValidated(res, 200, revisionsPageSchema, paginate(revisions, url.searchParams));
        return;
      }
    }

    if (sub[0] === "revisions" && sub.length === 2 && method === "GET") {
      const revision = ws.revisions.get(sub[1]!);
      if (!revision) {
        // Candidate content is never served here (C3).
        sendError(res, 404, "NOT_FOUND", "Unknown revision.");
        return;
      }
      sendValidated(res, 200, revisionResponseSchema, { revision });
      return;
    }

    if (sub[0] === "tags" && method === "GET") {
      sendValidated(res, 200, tagsPageSchema, paginate(sortedById(ws.tags.values()), url.searchParams));
      return;
    }
    if (sub[0] === "collections" && method === "GET") {
      sendValidated(
        res,
        200,
        collectionsPageSchema,
        paginate(sortedById(ws.collections.values()), url.searchParams),
      );
      return;
    }

    if (sub[0] === "proposals") {
      const canRead = (proposal?: Proposal): boolean => {
        if (caller.kind === "agent") {
          return proposal !== undefined && proposal.author.agentTokenId === caller.agentToken!.id;
        }
        return roleAtLeast(role, "contributor");
      };
      if (sub.length === 1 && method === "GET") {
        if (caller.kind !== "agent" && !roleAtLeast(role, "contributor")) {
          sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
          return;
        }
        let proposals = [...ws.proposals.values()];
        if (caller.kind === "agent") proposals = proposals.filter((p) => canRead(p));
        const promptId = url.searchParams.get("promptId");
        if (promptId) proposals = proposals.filter((p) => p.promptId === promptId);
        const status = url.searchParams.get("status");
        if (status) proposals = proposals.filter((p) => p.status === status);
        proposals.sort((a, b) => (a.id < b.id ? -1 : 1));
        sendValidated(res, 200, proposalsPageSchema, paginate(proposals, url.searchParams));
        return;
      }
      if (sub.length === 2 && method === "GET") {
        const proposal = ws.proposals.get(sub[1]!);
        if (!proposal || !canRead(proposal)) {
          if (proposal && caller.kind !== "agent" && !roleAtLeast(role, "contributor")) {
            sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
            return;
          }
          sendError(res, proposal ? 404 : 404, "NOT_FOUND", "Unknown proposal.");
          return;
        }
        const base = ws.revisions.get(proposal.baseRevisionId)!;
        const candidate = (ws.candidates.get(proposal.candidateRevisionId) ??
          ws.revisions.get(proposal.candidateRevisionId))!;
        const reviews = ws.reviews.filter((review) => review.proposalId === proposal.id);
        sendValidated(res, 200, proposalDetailResponseSchema, {
          proposal,
          base,
          candidate,
          reviews,
        });
        return;
      }
      if (sub[2] === "comments" && sub.length === 3 && method === "GET") {
        const proposal = ws.proposals.get(sub[1]!);
        if (!proposal || !canRead(proposal)) {
          sendError(res, proposal ? 403 : 404, proposal ? "ROLE_FORBIDDEN" : "NOT_FOUND", "Unavailable.");
          return;
        }
        const comments = ws.comments.filter((comment) => comment.proposalId === proposal.id);
        sendValidated(res, 200, commentsPageSchema, paginate(comments, url.searchParams));
        return;
      }
    }

    if (sub[0] === "activity-items" && method === "GET") {
      if (caller.kind !== "agent" && !roleAtLeast(role, "contributor")) {
        sendError(res, 403, "ROLE_FORBIDDEN", "Contributor role required.");
        return;
      }
      const promptId = url.searchParams.get("promptId");
      let items = ws.activity.filter((item) => item.promptId === promptId);
      if (caller.kind === "agent") {
        items = items.filter((item) => item.author.agentTokenId === caller.agentToken!.id);
      }
      sendValidated(res, 200, activityItemsPageSchema, paginate(items, url.searchParams));
      return;
    }

    if (sub[0] === "members" && method === "GET") {
      if (caller.kind !== "human" || role !== "owner") {
        if (caller.kind !== "human") refuseAgent(res);
        else sendError(res, 403, "ROLE_FORBIDDEN", "Owner role required.");
        return;
      }
      const members = [...ws.members.entries()].map(([userId, member]) => {
        const user = users.get(userId)!;
        return {
          userId,
          displayName: user.displayName,
          email: user.email,
          role: member.role,
          entityVersion: member.entityVersion,
        };
      });
      sendValidated(res, 200, membersPageSchema, paginate(members, url.searchParams));
      return;
    }

    if (sub[0] === "invitations" && method === "GET") {
      if (caller.kind !== "human" || role !== "owner") {
        sendError(res, 403, caller.kind !== "human" ? "SCOPE_FORBIDDEN" : "ROLE_FORBIDDEN", "Owner role required.");
        return;
      }
      const invitations = [...ws.invitations.values()].map(({ token: _token, ...rest }) => rest);
      sendValidated(res, 200, invitationsPageSchema, paginate(invitations, url.searchParams));
      return;
    }

    if (sub[0] === "audit" && method === "GET") {
      if (caller.kind !== "human" || role !== "owner") {
        sendError(res, 403, caller.kind !== "human" ? "SCOPE_FORBIDDEN" : "ROLE_FORBIDDEN", "Owner role required.");
        return;
      }
      const audit = ws.audit.map((entry) => auditEntrySchema.parse(entry));
      sendValidated(res, 200, auditPageSchema, paginate(audit, url.searchParams));
      return;
    }

    if (sub[0] === "export" && method === "GET") {
      if (caller.kind !== "human" || role !== "owner") {
        sendError(res, 403, caller.kind !== "human" ? "SCOPE_FORBIDDEN" : "ROLE_FORBIDDEN", "Owner role required.");
        return;
      }
      const lines = [
        JSON.stringify({ schemaVersion: 1, workspaceId: ws.id, exportedAt: nowIso() }),
        ...catalogueRecords(ws).map((record) => JSON.stringify(record)),
      ];
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "private, no-store",
        [REQUEST_ID_HEADER.toLowerCase()]: randomUUID(),
      });
      res.end(lines.join("\n") + "\n");
      return;
    }

    if (sub[0] === "agent-tokens") {
      if (caller.kind !== "human") return refuseAgent(res);
      if (sub.length === 1 && method === "GET") {
        const all = [...ws.agentTokens.values()];
        const visible = role === "owner" ? all : all.filter((t) => t.userId === caller.user.id);
        sendValidated(res, 200, agentTokensPageSchema, {
          items: visible.map((t) => ({
            id: t.id,
            name: t.name,
            userId: t.userId,
            scopes: t.scopes,
            expiresAt: t.expiresAt,
            createdAt: t.createdAt,
          })),
          nextPageToken: null,
        });
        return;
      }
      if (sub.length === 1 && method === "POST") {
        const parsed = createAgentTokenInputSchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 422, "VALIDATION_FAILED", "Invalid agent token input.");
          return;
        }
        if (!roleAtLeast(role, "contributor")) {
          const wantsWrite = parsed.data.scopes.some((s) => s !== "catalog:read");
          if (wantsWrite) {
            sendError(res, 403, "ROLE_FORBIDDEN", "A viewer cannot mint write scopes.");
            return;
          }
        }
        const receiptKey = `${ws.id}:${caller.principalId}:${parsed.data.commandId}`;
        const requestHash = sha256Hex(stableStringify(parsed.data));
        const existing = receipts.get(receiptKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            sendError(res, 409, "COMMAND_ID_REUSED", "This command id was already used with a different request.");
            return;
          }
          sendValidated(res, 200, agentTokenCreatedSchema, existing.body);
          return;
        }
        const id = randomUUID();
        const secret = `pbt_${id}.${Buffer.from(randomUUID()).toString("base64url")}`;
        const expiresAt = new Date(
          Date.now() + parsed.data.expiresInDays * 24 * 3600 * 1000,
        ).toISOString();
        ws.agentTokens.set(id, {
          id,
          name: parsed.data.name,
          userId: caller.user.id,
          scopes: parsed.data.scopes,
          bearerToken: secret,
          expiresAt,
          createdAt: nowIso(),
          revokedAt: null,
        });
        const responseBody = { id, token: secret, expiresAt, secretAvailable: true };
        receipts.set(receiptKey, { requestHash, status: 201, body: { id, expiresAt, secretAvailable: false } });
        sendValidated(res, 201, agentTokenCreatedSchema, responseBody);
        return;
      }
      if (sub.length === 2 && method === "DELETE") {
        const token = ws.agentTokens.get(sub[1]!);
        if (!token) {
          sendError(res, 404, "NOT_FOUND", "Unknown agent token.");
          return;
        }
        if (token.userId !== caller.user.id && role !== "owner") {
          sendError(res, 403, "ROLE_FORBIDDEN", "Only the token owner or a workspace owner can revoke it.");
          return;
        }
        token.revokedAt = nowIso();
        sendValidated(res, 200, okResponseSchema, { ok: true });
        return;
      }
    }

    sendError(res, 404, "NOT_FOUND", "Unknown route.");
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = (error as { mockStatus?: number }).mockStatus;
      if (status === 413) {
        sendError(res, 413, "PAYLOAD_TOO_LARGE", "The request body exceeds the 256 KiB ceiling.");
      } else if (status === 422) {
        sendError(res, 422, "VALIDATION_FAILED", "The request failed validation.");
      } else {
        sendError(res, 503, "UNAVAILABLE", "Mock internal error.", true);
      }
    });
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }
  const origin = `http://${host}:${address.port}`;

  const handle: MockServerHandle = {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
    state: {
      get proposalCount() {
        return [...workspaces.values()].reduce((count, ws) => count + ws.proposals.size, 0);
      },
      get receiptCount() {
        return receipts.size;
      },
    },
    [Symbol.asyncDispose]: async () => {
      await handle.close();
    },
  };
  return handle;
}
