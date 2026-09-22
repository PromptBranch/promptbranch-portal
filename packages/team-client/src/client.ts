import type { z } from "zod";
import {
  acceptInvitationInputSchema,
  activityItemsPageSchema,
  agentTokenCreatedSchema,
  agentTokensPageSchema,
  auditPageSchema,
  bootstrapInputSchema,
  bootstrapPageSchema,
  bootstrapStartSchema,
  changesInputSchema,
  changesPageSchema,
  collectionsPageSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  commentsPageSchema,
  createAgentTokenInputSchema,
  createWorkspaceInputSchema,
  deleteMeInputSchema,
  healthReadySchema,
  invitationsPageSchema,
  listActivityQuerySchema,
  listPromptsQuerySchema,
  listProposalsQuerySchema,
  meResponseSchema,
  membersPageSchema,
  okResponseSchema,
  principalResponseSchema,
  promptDetailResponseSchema,
  promptsPageSchema,
  proposalDetailResponseSchema,
  proposalsPageSchema,
  REQUIRED_FEATURES,
  revisionResponseSchema,
  revisionsPageSchema,
  sessionsPageSchema,
  tagsPageSchema,
  TEAM_LIMITS,
  teamInfoSchema,
  workspaceResponseSchema,
  workspacesPageSchema,
  type AcceptInvitationInput,
  type ActivityItem,
  type AgentTokenCreated,
  type AgentTokenMetadata,
  type AuditEntry,
  type BootstrapInput,
  type BootstrapPage,
  type BootstrapStart,
  type ChangesInput,
  type ChangesPage,
  type Collection,
  type CommandEnvelope,
  type CommandReceipt,
  type Comment,
  type CreateWorkspaceInput,
  type DeleteMeInput,
  type Invitation,
  type Member,
  type MeResponse,
  type Page,
  type PrincipalResponse,
  type Prompt,
  type Proposal,
  type ProposalDetailResponse,
  type Revision,
  type Session,
  type Tag,
  type TeamInfo,
  type Workspace,
} from "@promptbranch/team-contract";
import { TeamTransportError } from "./errors.js";
import {
  EXPORT_TIMEOUT_MS,
  TeamTransport,
  type FetchLike,
  type TeamClock,
  type TeamRequest,
  type TeamStreamResponse,
  type TokenSource,
} from "./transport.js";

export interface TeamClientOptions {
  /** Team server origin; normalized and pinned (C2). HTTPS, or loopback HTTP. */
  origin: string;
  /** Resolves the current bearer token per request; required for authed routes. */
  tokenSource?: TokenSource;
  fetchImpl?: FetchLike;
  clock?: TeamClock;
  /** Per-request timeout; default 15 s. */
  timeoutMs?: number;
  /** Export stream timeout; default 120 s. */
  exportTimeoutMs?: number;
  /** Total attempts per call including the first; default 4. */
  maxAttempts?: number;
  /** Buffered response ceiling; default 512 KiB (C2 page cap). */
  maxResponseBytes?: number;
  /** Export stream ceiling; default 200 MiB (C2 published-content bound). */
  maxExportBytes?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface PageQuery {
  limit?: number;
  pageToken?: string;
}

export type ListPromptsArgs = z.input<typeof listPromptsQuerySchema>;
export type ListProposalsArgs = z.input<typeof listProposalsQuerySchema>;
export type ListActivityArgs = z.input<typeof listActivityQuerySchema>;
export type CreateAgentTokenArgs = z.input<typeof createAgentTokenInputSchema>;

export interface TeamExport {
  requestId: string | null;
  /** Raw NDJSON lines, starting with the manifest record. */
  lines: AsyncIterable<string>;
}

/**
 * The PB-TEAM-1 client surface: one method per C4 route. A caller always
 * names the origin (at construction) and the workspace (per call); there is
 * deliberately no ambient or Personal fallback. Owner/admin methods exist
 * for web-link management integrations; nothing here is exposed to MCP.
 */
export interface TeamClient {
  info(options?: CallOptions): Promise<TeamInfo>;
  getMe(options?: CallOptions): Promise<MeResponse>;
  deleteMe(input: DeleteMeInput, options?: CallOptions): Promise<{ ok: true }>;
  getPrincipal(options?: CallOptions): Promise<PrincipalResponse>;
  listWorkspaces(query?: PageQuery, options?: CallOptions): Promise<Page<Workspace>>;
  createWorkspace(
    input: CreateWorkspaceInput,
    options?: CallOptions,
  ): Promise<{ workspace: Workspace }>;
  getWorkspace(workspaceId: string, options?: CallOptions): Promise<Workspace>;
  listPrompts(
    workspaceId: string,
    query?: ListPromptsArgs,
    options?: CallOptions,
  ): Promise<Page<Prompt>>;
  getPrompt(
    workspaceId: string,
    promptId: string,
    options?: CallOptions,
  ): Promise<{ prompt: Prompt; revision: Revision }>;
  listRevisions(
    workspaceId: string,
    promptId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<Revision>>;
  getRevision(workspaceId: string, revisionId: string, options?: CallOptions): Promise<Revision>;
  listTags(workspaceId: string, query?: PageQuery, options?: CallOptions): Promise<Page<Tag>>;
  listCollections(
    workspaceId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<Collection>>;
  listProposals(
    workspaceId: string,
    query?: ListProposalsArgs,
    options?: CallOptions,
  ): Promise<Page<Proposal>>;
  getProposal(
    workspaceId: string,
    proposalId: string,
    options?: CallOptions,
  ): Promise<ProposalDetailResponse>;
  listProposalComments(
    workspaceId: string,
    proposalId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<Comment>>;
  listActivityItems(
    workspaceId: string,
    query: ListActivityArgs,
    options?: CallOptions,
  ): Promise<Page<ActivityItem>>;
  listMembers(workspaceId: string, query?: PageQuery, options?: CallOptions): Promise<Page<Member>>;
  listInvitations(
    workspaceId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<Invitation>>;
  acceptInvitation(
    input: AcceptInvitationInput,
    options?: CallOptions,
  ): Promise<{ workspace: Workspace }>;
  listAudit(
    workspaceId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<AuditEntry>>;
  exportWorkspace(workspaceId: string, options?: CallOptions): Promise<TeamExport>;
  listSessions(query?: PageQuery, options?: CallOptions): Promise<Page<Session>>;
  revokeSession(sessionId: string, options?: CallOptions): Promise<{ ok: true }>;
  revokeAllSessions(options?: CallOptions): Promise<{ ok: true }>;
  listAgentTokens(
    workspaceId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<Page<AgentTokenMetadata>>;
  createAgentToken(
    workspaceId: string,
    input: CreateAgentTokenArgs,
    options?: CallOptions,
  ): Promise<AgentTokenCreated>;
  revokeAgentToken(
    workspaceId: string,
    tokenId: string,
    options?: CallOptions,
  ): Promise<{ ok: true }>;
  command(
    workspaceId: string,
    epoch: string,
    input: CommandEnvelope,
    options?: CallOptions,
  ): Promise<CommandReceipt>;
  bootstrap(
    workspaceId: string,
    input: BootstrapInput,
    options?: CallOptions,
  ): Promise<BootstrapStart>;
  bootstrapPage(
    workspaceId: string,
    snapshotId: string,
    query?: PageQuery,
    options?: CallOptions,
  ): Promise<BootstrapPage>;
  changes(workspaceId: string, input: ChangesInput, options?: CallOptions): Promise<ChangesPage>;
  healthReady(options?: CallOptions): Promise<{ ready: boolean }>;
}

function summarizeIssues(issues: readonly z.core.$ZodIssue[], withMessages: boolean): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "(root)";
      return withMessages ? `${path}: ${issue.message}` : `${path}: ${issue.code}`;
    })
    .join("; ");
}

/** Validates a request body locally; failures happen before any network I/O. */
function validateInput<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TeamTransportError(
      "invalid-request",
      `The request failed local contract validation: ${summarizeIssues(result.error.issues, true)}.`,
    );
  }
  return result.data;
}

function validateQuery(query: PageQuery | undefined): Record<string, string | number | undefined> {
  if (query === undefined) return {};
  const { limit, pageToken } = query;
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > TEAM_LIMITS.maxPageSize)
  ) {
    throw new TeamTransportError(
      "invalid-request",
      `Page limit must be an integer between 1 and ${TEAM_LIMITS.maxPageSize}.`,
    );
  }
  return { limit, pageToken };
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function parseJsonBody(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TeamTransportError(
      "invalid-json",
      `HTTP ${status} returned a body that is not valid JSON.`,
      status,
    );
  }
}

async function* iterateNdjsonLines(
  stream: TeamStreamResponse,
  maxBytes: number,
): AsyncGenerator<string> {
  try {
    const body = stream.response.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let total = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          // Raw read failures (abort/timeout/reset mid-stream) map onto the
          // typed surface via the originating request's state.
          throw stream.mapReadError(error);
        }
        const { done, value } = chunk;
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Best-effort cleanup; the cap error below is what matters.
          }
          throw new TeamTransportError(
            "response-too-large",
            `The export exceeds the ${maxBytes}-byte bound.`,
            stream.status,
          );
        }
        buffered += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line !== "") yield line;
        }
      }
      buffered += decoder.decode();
      if (buffered !== "") yield buffered;
    } finally {
      reader.releaseLock();
    }
  } finally {
    stream.finish();
  }
}

export function createTeamClient(options: TeamClientOptions): TeamClient {
  const transport = new TeamTransport({
    origin: options.origin,
    tokenSource: options.tokenSource,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts,
    maxResponseBytes: options.maxResponseBytes,
  });
  const exportTimeoutMs = options.exportTimeoutMs ?? EXPORT_TIMEOUT_MS;
  const maxExportBytes = options.maxExportBytes ?? TEAM_LIMITS.maxPublishedContentBytes;

  async function call<Schema extends z.ZodType>(
    spec: TeamRequest,
    schema: Schema,
    accepted: readonly number[],
  ): Promise<z.output<Schema>> {
    const response = await transport.request(spec);
    if (!accepted.includes(response.status)) {
      throw new TeamTransportError(
        "invalid-response",
        `Unexpected status ${response.status}.`,
        response.status,
      );
    }
    const parsed = parseJsonBody(response.bodyText, response.status);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // Paths/codes only: response values never enter the error (C2).
      throw new TeamTransportError(
        "invalid-response",
        `The response did not match the team contract: ${summarizeIssues(result.error.issues, false)}.`,
        response.status,
      );
    }
    return result.data;
  }

  const authed = (spec: Omit<TeamRequest, "auth">): TeamRequest => ({ ...spec, auth: "required" });
  const workspacePath = (workspaceId: string, rest = "") =>
    `/workspaces/${encodeId(workspaceId)}${rest}`;

  return {
    async info(callOptions) {
      const info = await call(
        {
          method: "GET",
          path: "/info",
          auth: "none",
          protocolHeader: false,
          signal: callOptions?.signal,
        },
        teamInfoSchema,
        [200],
      );
      // C2: refuse team activation when a required feature is missing.
      const missing = REQUIRED_FEATURES.filter((feature) => !info.features.includes(feature));
      if (missing.length > 0) {
        throw new TeamTransportError(
          "unsupported-server",
          `The team server does not offer required features: ${missing.join(", ")}.`,
        );
      }
      return info;
    },

    getMe: async (callOptions) =>
      call(
        authed({ method: "GET", path: "/me", signal: callOptions?.signal }),
        meResponseSchema,
        [200],
      ),

    deleteMe: async (input, callOptions) =>
      call(
        authed({
          method: "DELETE",
          path: "/me",
          body: validateInput(deleteMeInputSchema, input),
          signal: callOptions?.signal,
        }),
        okResponseSchema,
        [200],
      ),

    getPrincipal: async (callOptions) =>
      call(
        authed({ method: "GET", path: "/principal", signal: callOptions?.signal }),
        principalResponseSchema,
        [200],
      ),

    listWorkspaces: async (query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: "/workspaces",
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        workspacesPageSchema,
        [200],
      ),

    createWorkspace: async (input, callOptions) =>
      call(
        authed({
          method: "POST",
          path: "/workspaces",
          body: validateInput(createWorkspaceInputSchema, input),
          signal: callOptions?.signal,
        }),
        workspaceResponseSchema,
        // 201 on creation, 200 on receipt replay (C4).
        [200, 201],
      ),

    async getWorkspace(workspaceId, callOptions) {
      const body = await call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId),
          signal: callOptions?.signal,
        }),
        workspaceResponseSchema,
        [200],
      );
      return body.workspace;
    },

    listPrompts: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/prompts"),
          query: validateInput(listPromptsQuerySchema, query ?? {}),
          signal: callOptions?.signal,
        }),
        promptsPageSchema,
        [200],
      ),

    getPrompt: async (workspaceId, promptId, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/prompts/${encodeId(promptId)}`),
          signal: callOptions?.signal,
        }),
        promptDetailResponseSchema,
        [200],
      ),

    listRevisions: async (workspaceId, promptId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/prompts/${encodeId(promptId)}/revisions`),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        revisionsPageSchema,
        [200],
      ),

    async getRevision(workspaceId, revisionId, callOptions) {
      const body = await call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/revisions/${encodeId(revisionId)}`),
          signal: callOptions?.signal,
        }),
        revisionResponseSchema,
        [200],
      );
      return body.revision;
    },

    listTags: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/tags"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        tagsPageSchema,
        [200],
      ),

    listCollections: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/collections"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        collectionsPageSchema,
        [200],
      ),

    listProposals: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/proposals"),
          query: validateInput(listProposalsQuerySchema, query ?? {}),
          signal: callOptions?.signal,
        }),
        proposalsPageSchema,
        [200],
      ),

    getProposal: async (workspaceId, proposalId, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/proposals/${encodeId(proposalId)}`),
          signal: callOptions?.signal,
        }),
        proposalDetailResponseSchema,
        [200],
      ),

    listProposalComments: async (workspaceId, proposalId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/proposals/${encodeId(proposalId)}/comments`),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        commentsPageSchema,
        [200],
      ),

    listActivityItems: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/activity-items"),
          query: validateInput(listActivityQuerySchema, query),
          signal: callOptions?.signal,
        }),
        activityItemsPageSchema,
        [200],
      ),

    listMembers: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/members"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        membersPageSchema,
        [200],
      ),

    listInvitations: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/invitations"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        invitationsPageSchema,
        [200],
      ),

    acceptInvitation: async (input, callOptions) =>
      call(
        authed({
          method: "POST",
          path: "/invitations/accept",
          body: validateInput(acceptInvitationInputSchema, input),
          signal: callOptions?.signal,
        }),
        workspaceResponseSchema,
        [200],
      ),

    listAudit: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/audit"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        auditPageSchema,
        [200],
      ),

    async exportWorkspace(workspaceId, callOptions) {
      const stream = await transport.openStream(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/export"),
          signal: callOptions?.signal,
          timeoutMs: exportTimeoutMs,
        }),
      );
      const contentType = stream.response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/x-ndjson")) {
        try {
          await stream.response.body?.cancel();
        } catch {
          // Best-effort cleanup.
        }
        stream.finish();
        throw new TeamTransportError(
          "invalid-response",
          "The export response was not NDJSON.",
          stream.status,
        );
      }
      return {
        requestId: stream.requestId,
        lines: iterateNdjsonLines(stream, maxExportBytes),
      };
    },

    listSessions: async (query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: "/sessions",
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        sessionsPageSchema,
        [200],
      ),

    revokeSession: async (sessionId, callOptions) =>
      call(
        authed({
          method: "DELETE",
          path: `/sessions/${encodeId(sessionId)}`,
          signal: callOptions?.signal,
        }),
        okResponseSchema,
        [200],
      ),

    revokeAllSessions: async (callOptions) =>
      call(
        authed({ method: "POST", path: "/sessions/revoke-all", body: {}, signal: callOptions?.signal }),
        okResponseSchema,
        [200],
      ),

    listAgentTokens: async (workspaceId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/agent-tokens"),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        agentTokensPageSchema,
        [200],
      ),

    createAgentToken: async (workspaceId, input, callOptions) =>
      call(
        authed({
          method: "POST",
          path: workspacePath(workspaceId, "/agent-tokens"),
          body: validateInput(createAgentTokenInputSchema, input),
          signal: callOptions?.signal,
        }),
        agentTokenCreatedSchema,
        // 201 on first mint, 200 on receipt replay without the secret (C4).
        [200, 201],
      ),

    revokeAgentToken: async (workspaceId, tokenId, callOptions) =>
      call(
        authed({
          method: "DELETE",
          path: workspacePath(workspaceId, `/agent-tokens/${encodeId(tokenId)}`),
          signal: callOptions?.signal,
        }),
        okResponseSchema,
        [200],
      ),

    command: async (workspaceId, epoch, input, callOptions) =>
      call(
        authed({
          method: "POST",
          path: workspacePath(workspaceId, "/commands"),
          body: validateInput(commandEnvelopeSchema, input),
          epoch,
          signal: callOptions?.signal,
        }),
        commandReceiptSchema,
        [200],
      ),

    bootstrap: async (workspaceId, input, callOptions) =>
      call(
        authed({
          method: "POST",
          path: workspacePath(workspaceId, "/bootstrap"),
          body: validateInput(bootstrapInputSchema, input),
          signal: callOptions?.signal,
        }),
        bootstrapStartSchema,
        // 201 on creation, 200 on reuse of an active snapshot (C7).
        [200, 201],
      ),

    bootstrapPage: async (workspaceId, snapshotId, query, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, `/bootstrap/${encodeId(snapshotId)}`),
          query: validateQuery(query),
          signal: callOptions?.signal,
        }),
        bootstrapPageSchema,
        [200],
      ),

    changes: async (workspaceId, input, callOptions) =>
      call(
        authed({
          method: "GET",
          path: workspacePath(workspaceId, "/changes"),
          query: validateInput(changesInputSchema, input),
          signal: callOptions?.signal,
        }),
        changesPageSchema,
        [200],
      ),

    healthReady: async (callOptions) =>
      call(
        {
          method: "GET",
          path: "/health/ready",
          auth: "none",
          protocolHeader: false,
          signal: callOptions?.signal,
        },
        healthReadySchema,
        [200],
      ),
  };
}
