# Team integration contract PB-TEAM-1

Status: implementation baseline proposed on 2026-09-21. Contract package target:
`@promptbranch/team-contract@1.0.0`, HTTP major `/api/team/v1`. This entire section
is embedded identically in both implementation plans. It is sufficient to build
a mock provider or consumer without the other repository. Change it through a
coordinated contract revision, not an undocumented adapter workaround.

## C1. Product and authority

Personal PromptBranch remains account-free, local-first, and compatible with its
current SQLite/CLI/MCP/P2P workflow. A team workspace is a server-owned library
with immutable revisions and human-controlled approval. Team caches are separate
databases and never enter the personal sync registry. This first release supports
small teams, browser collaboration, desktop offline reading/drafting, and scoped
CLI/MCP. All users in a workspace can read its approved catalogue. Collections
organize content; they do not restrict access.

V1 excludes live co-editing, per-collection permissions, centralized model
execution/billing, SAML/SCIM, mobile work, guest links, and publishing team content
to the anonymous snapshot service. Personal sharing remains available. Readers
can copy content; no export restriction can prevent that. Server administrators
can access team data; this is TLS-protected client/server storage, not end-to-end
encrypted or zero-knowledge hosting.

Roles are `owner | maintainer | contributor | viewer`. `owner` includes all
maintainer actions. Owner manages invitations, roles, ownership transfer,
workspace deletion and audit export. Maintainer creates initial approved
prompts, organizes metadata, reviews proposals, archives/restores prompts, and
rolls back approved heads. Contributor submits proposals, comments, notes, and
run summaries. Viewer reads/copies approved catalogue only. Self-review is
forbidden: the reviewer must differ from the proposal's human author, including
the human associated with an agent credential. A sole owner may seed new prompts
and roll back to an already-approved revision, but may not bypass review on a
proposal; UI must explain that a second maintainer is needed.

Agent credentials are workspace-scoped capabilities owned by a member, never an
independent role. Supported scopes: `catalog:read`, `proposal:write`,
`note:write`, `run:write`. Effective access is the intersection of scopes and
current owner-member role. Every token includes `catalog:read`; a viewer cannot
mint write scopes. `proposal:write` additionally permits commenting on and
withdrawing that token's own proposals, never reviewing. No agent capability
permits reviewing, membership changes, exporting the whole workspace, public
publishing, or creating another token. The server enforces this for direct calls.

## C2. Wire conventions and compatibility

- HTTPS origin with no path prefix in production; HTTP allowed only on explicit
  loopback development origins. Normalize origin and bind credentials to it.
  Never follow a redirect with an Authorization header or accept credentials in
  URLs. Unknown origins need an explicit connect action, never a deep-link login.
- UUID strings for domain IDs and `commandId`; UTC RFC3339 timestamps. Sequences
  are decimal strings, not JavaScript numbers. Content is UTF-8; preserve original
  line endings/content. No implicit Unicode or whitespace normalization of text.
- All team responses: `Cache-Control: private, no-store`, `Vary: Cookie, Authorization`,
  `X-Content-Type-Options: nosniff`. No body or authorization values in logs.
- Caller sends `X-PromptBranch-Team-Protocol: 1`. Discovery is exempt. Unsupported
  major returns 426 before any domain mutation. `serverEpoch` changes on disaster
  restore or incompatible data reset; cache must bootstrap again.
- Requests use strict Zod objects, reject unknown fields. Responses accept unknown
  optional fields for forward compatibility but reject unknown discriminated
  entity/command/event kinds; pause sync without advancing a cursor in that case.
- Required features in discovery: `catalog-v1`, `review-v1`, `changes-v1`,
  `agent-token-v1`. Client refuses team activation if one is missing. Patch/minor
  package updates are additive; breaking field/state/permission changes require
  a new HTTP major. Existing public snapshot API and personal P2P versions do not change.
- Error: `{ error: { code, message, requestId, retryable, details? } }`.
  Stable codes: `UNAUTHENTICATED` 401; `SESSION_REVOKED` 401;
  `WORKSPACE_FORBIDDEN` 403; `ROLE_FORBIDDEN` 403; `SCOPE_FORBIDDEN` 403;
  `NOT_FOUND` 404; `VALIDATION_FAILED` 422; `SECRET_BLOCKED` 422;
  `STALE_BASE`, `STALE_ENTITY`, `SELF_REVIEW`, `LAST_OWNER`,
  `COMMAND_ID_REUSED` 409; `CURSOR_EXPIRED`, `SNAPSHOT_EXPIRED`,
  `SERVER_EPOCH_CHANGED` 410; `PROTOCOL_UNSUPPORTED` 426;
  `RATE_LIMITED`, `QUOTA_EXCEEDED` 429; `UNAVAILABLE` 503;
  `PAYLOAD_TOO_LARGE` 413; `MEMBERSHIP_CHANGED` 409.
  Resource IDs outside an authorized workspace return 404. A workspace supplied
  directly by a nonmember returns generic 403, without its name or metadata.
- Network/503/RATE_LIMITED are retryable; honor Retry-After, exponential backoff
  1–60 s with jitter. QUOTA_EXCEEDED is nonretryable until a user resolves capacity,
  despite its 429 status. Refresh an expired human access token once, then require login.
  Never auto-retry 409/422/permission failure with a new command ID.
- Body ceiling 256 KiB, enforced before and while reading, not only after JSON
  parsing. Content ≤64 KiB UTF-8; title 1–200 characters; description ≤2,000;
  rationale/comment/note ≤8,000; tag name 1–50, at most 20 per prompt;
  collection name 1–100, at most 20 memberships per prompt. Search ≤200 chars;
  page `limit` 1–100, default 50; serialized response pages ≤512 KiB. One entity
  fits a page; never split a row. API summary list items omit revision content.

`TeamInfo.limits` keys are `maxRequestBytes:262144`, `maxResponsePageBytes:524288`,
`maxContentBytes:65536`, `maxPageSize:100`, `maxMembers:50`, `maxPrompts:5000`,
`maxPublishedContentBytes:209715200`, `maxProposals:50000`,
`maxActiveTokensPerMember:20`. `features` is a string array and `serverId`/
`serverEpoch` are UUIDs. Every Workspace.serverEpoch equals the server's active
epoch; epoch changes invalidate all its workspace caches. Effective operator
quotas may be lower and are returned here. Required byte bounds cannot be raised
within protocol v1. Standard diagnostic response header is `X-Request-ID`.

## C3. DTOs and state machines

The following TypeScript is the minimum exported type vocabulary; the contract
package supplies equivalent runtime schemas for every input/output below.

```ts
export type Id = string;
export type Seq = string;
export type Role = "owner" | "maintainer" | "contributor" | "viewer";
export type Scope = "catalog:read" | "proposal:write" | "note:write" | "run:write";
export interface Actor { userId: Id; displayName: string; agentTokenId: Id | null }
export interface Workspace {
  id: Id; name: string; role: Role; membershipGeneration: Id;
  serverEpoch: Id; entityVersion: number; updatedAt: string;
}
export interface Prompt {
  id: Id; workspaceId: Id; title: string; description: string;
  approvedRevisionId: Id; tagIds: Id[]; collectionIds: Id[];
  entityVersion: number; archivedAt: string | null; createdAt: string; updatedAt: string;
}
export interface Revision {
  id: Id; workspaceId: Id; promptId: Id; parentRevisionId: Id | null;
  content: string; contentFormat: "markdown"; contentHash: string;
  changeNote: string; author: Actor; createdAt: string;
}
export interface Proposal {
  id: Id; workspaceId: Id; promptId: Id; baseRevisionId: Id;
  candidateRevisionId: Id; rationale: string; author: Actor;
  status: "open" | "approved" | "rejected" | "withdrawn" | "superseded";
  supersedesProposalId: Id | null; entityVersion: number;
  createdAt: string; updatedAt: string;
}
export interface Review {
  id: Id; proposalId: Id; candidateRevisionId: Id; candidateContentHash: string;
  reviewer: Actor; decision: "approve" | "reject"; comment: string; createdAt: string;
}
export interface Tag { id: Id; workspaceId: Id; name: string; entityVersion: number }
export interface Collection { id: Id; workspaceId: Id; name: string; entityVersion: number }
export interface Comment { id: Id; proposalId: Id; body: string; author: Actor; createdAt: string }
export interface ActivityItem {
  id: Id; workspaceId: Id; promptId: Id; revisionId: Id; author: Actor;
  kind: "note" | "run"; body: string; createdAt: string;
  run: null | { model: string | null; status: "completed" | "failed" | "cancelled";
    latencyMs: number | null; inputTokens: number | null; outputTokens: number | null;
    estimatedCostUsd: number | null };
}
export type CatalogRecord =
  | { entity: "prompt"; value: Prompt }
  | { entity: "revision"; value: Revision }
  | { entity: "tag"; value: Tag }
  | { entity: "collection"; value: Collection };
export interface Change {
  seq: Seq; records: CatalogRecord[];
  tombstones: { entity: "prompt" | "tag" | "collection"; id: Id }[];
}
export interface CommandEnvelope {
  commandId: Id; membershipGeneration: Id; operation: TeamOperation;
}
export interface CommandReceipt {
  commandId: Id; committedAt: string; catalogSeq: Seq;
  result: { kind: string; id: Id; entityVersion?: number };
}
export interface ErrorBody {
  error: { code: string; message: string; requestId: Id; retryable: boolean;
    details?: Record<string, unknown> };
}
export interface Page<T> { items: T[]; nextPageToken: string | null }
```

`contentHash = lowercase SHA-256(UTF8(content))`, computed/verified by the server;
hash alone does not prove approval. Team revision IDs/content/parent/author identity
never change. Actor.displayName is presentation resolved from the current account,
including `Former member` after account deletion; it is not approval evidence.
Only revisions with an approval/initial-seed record enter catalogue APIs,
search, bootstrap and feed. `/revisions/:id` must verify publication, not merely
that its prompt is visible. Candidate content is obtained only through proposal
detail by contributor/maintainer/owner; viewer cannot see proposals, comments or
activity items. Collaboration responses are live and not in the offline catalogue.

Creating a prompt is a maintainer-authorized seed that atomically creates its
first approved revision and audit entry. All subsequent new content goes through
a proposal. Submission may target an older, previously approved revision of the
same prompt; the proposal is marked stale in the UI. Approval requires current
approved head = proposal base = `expectedApprovedRevisionId` and exact candidate
ID/hash. Reject never changes the approved head. Editing/rebasing a submitted
proposal creates a new immutable candidate/new proposal and atomically supersedes
the old open proposal. Only its author can supersede/withdraw it. Rejection,
withdrawal, supersession and approval are terminal. Archived prompts remain in
catalogue with `archivedAt`; normal browse/search excludes them. Approval or new
submission on an archived prompt returns STALE_ENTITY. Restore makes it usable.

Rollback selects an already-published revision of the same prompt, atomically
updates the approved pointer after expected-head comparison, and records an audit
event. It never edits history or invents a new approval. Metadata mutations use
`expectedEntityVersion`; content changes do not piggyback on metadata commands.

## C4. API surface

All paths below are relative to `/api/team/v1`. Inputs/outputs are JSON except
the authenticated owner NDJSON export. Every successful response includes a
`requestId` header. GETs are side-effect free; membership/auth checks run before
reading a stored receipt or returning a private cacheable representation.
Success status is 200 unless creating a workspace, agent token or bootstrap
snapshot (201 on creation, 200 on receipt replay or reuse of an active snapshot). Domain commands
always return 200 CommandReceipt; clients accept the defined 200/201 variants.

| Method/path | Input | Success output / rule |
|---|---|---|
| GET `/info` | None; public | `{protocol:1,contractVersion:"1.0.0",serverId,serverEpoch,features,issuer,nativeClientId,cliClientId,audience,limits}`; serverId stable UUID, no secret endpoints |
| GET `/me` | Human bearer or web session | `{user:{id,displayName,email},workspaces:Workspace[]}`; verified-email human only |
| DELETE `/me` | Human fresh login, `{confirmEmail:string}` | `{ok:true}` after account disable/anonymization and last-owner checks |
| GET `/principal` | Human or agent | `{kind:"human"\|"agent",principalId,userId,agentTokenId:Id\|null,scopes:Scope[]}`; server-authored cache identity, no secret; principalId is `human:<userId>` or `agent:<tokenId>` |
| GET `/workspaces` | Human auth | `Page<Workspace>`; agent gets only its workspace |
| POST `/workspaces` | Human `{commandId,name}` | `{workspace:Workspace}`; idempotent per human; creator sole owner |
| GET `/workspaces/:w` | Member auth | `{workspace:Workspace}`; role and generation always freshly resolved |
| GET `/workspaces/:w/prompts` | `q?,tagId?,collectionId?,archived=false,limit?,pageToken?` | `Page<Prompt>`; approved title/description/tags/content search only; stable title/id order |
| GET `/workspaces/:w/prompts/:p` | Member auth | `{prompt:Prompt,revision:Revision}` for approved head |
| GET `/workspaces/:w/prompts/:p/revisions` | Pagination | `Page<Revision>` published history, newest first |
| GET `/workspaces/:w/revisions/:r` | Member auth | `{revision:Revision}`; published only |
| GET `/workspaces/:w/tags` and `/collections` | Pagination | `Page<Tag>` / `Page<Collection>` |
| GET `/workspaces/:w/proposals` | `promptId?,status?,limit?,pageToken?` | `Page<Proposal>`; contributor+; agent only own proposals |
| GET `/workspaces/:w/proposals/:p` | Contributor+ or authoring agent | `{proposal,base:Revision,candidate:Revision,reviews:Review[]}` |
| GET `/workspaces/:w/proposals/:p/comments` | Pagination; same proposal permission | `Page<Comment>` |
| GET `/workspaces/:w/activity-items` | `promptId,limit?,pageToken?` | `Page<ActivityItem>`; contributor+; agent may read only items it created |
| GET `/workspaces/:w/members` | Owner only | `Page<{userId,displayName,email,role,entityVersion}>` |
| GET `/workspaces/:w/invitations` | Owner only | `Page<{id,email,role,status,expiresAt}>`; no raw token |
| POST `/invitations/accept` | Verified human `{commandId,token}` | `{workspace:Workspace}`; identity-bound, idempotent acceptance |
| GET `/workspaces/:w/audit` | Owner; pagination | `Page<{id,actor,action,resourceType,resourceId,createdAt}>`; no secrets/content |
| GET `/workspaces/:w/export` | Owner, online | NDJSON; schemaVersion 1, manifest then domain entities; no tokens/session data; bounded streaming |
| GET `/sessions` | Human | `Page<{id,clientId,createdAt,lastSeenAt,revokedAt}>`; own sessions |
| DELETE `/sessions/:id` | Human, own session | `{ok:true}`; revocation takes effect on next request |
| POST `/sessions/revoke-all` | Human `{}` | `{ok:true}`; revoke own human sessions and agent tokens |
| GET `/workspaces/:w/agent-tokens` | Human | Own token metadata; owner may list all; secret never returned |
| POST `/workspaces/:w/agent-tokens` | Human contributor+ or viewer read-only; `{commandId,name,scopes,expiresInDays}` | `{id,token?,expiresAt,secretAvailable:boolean}`; 1–90 days, default 30; secret first response only |
| DELETE `/workspaces/:w/agent-tokens/:id` | Token owner or workspace owner, human | `{ok:true}`; immediately disables capability |
| POST `/workspaces/:w/commands` | CommandEnvelope | CommandReceipt; exact operation union below |
| POST `/workspaces/:w/bootstrap` | `{membershipGeneration,serverEpoch}` | `{snapshotId,highWater:Seq,expiresAt,serverEpoch,membershipGeneration}` |
| GET `/workspaces/:w/bootstrap/:s` | `pageToken?` | `{snapshotId,records:CatalogRecord[],nextPageToken,highWater,serverEpoch,membershipGeneration}` |
| GET `/workspaces/:w/changes` | `after:Seq,serverEpoch,membershipGeneration,limit?` | `{changes:Change[],nextCursor:Seq,hasMore:boolean,serverEpoch,membershipGeneration}` |
| GET `/health/ready` | Infrastructure only; no protocol/auth header required | `{ready:true}` 200 or `{ready:false}` 503; no private data or dependency details |

`TeamOperation` is a strict discriminated union on `type`. For exact compilation,
each row below becomes `{ type: <literal> } & <fields>`; no additional fields.
Every operation targets the workspace from the URL, never a client actor field.

| type | Fields excluding type | Permission/result.kind |
|---|---|---|
| `prompt.create` | `title,description,content,tagIds:Id[],collectionIds:Id[],changeNote` | Maintainer; `prompt` |
| `prompt.metadata` | `promptId,title,description,tagIds,collectionIds,expectedEntityVersion:number` | Maintainer; `prompt` |
| `prompt.archive` / `prompt.restore` | `promptId,expectedEntityVersion` | Maintainer; `prompt` |
| `prompt.rollback` | `promptId,targetRevisionId,expectedApprovedRevisionId,reason:string` | Maintainer; `prompt` |
| `proposal.submit` | `promptId,baseRevisionId,content,rationale,supersedesProposalId:Id\|null` | Contributor; `proposal` |
| `proposal.withdraw` | `proposalId,expectedEntityVersion` | Own human or own agent proposal; `proposal` |
| `proposal.review` | `proposalId,expectedEntityVersion,candidateRevisionId,candidateContentHash,expectedApprovedRevisionId,decision:"approve"\|"reject",comment` | Human maintainer, not author; `review` |
| `comment.add` | `proposalId,body` | Contributor; `comment` |
| `note.add` | `promptId,revisionId,body` | Contributor; `activityItem` |
| `run.report` | `promptId,revisionId,body,model:string\|null,status:"completed"\|"failed"\|"cancelled",latencyMs:number\|null,inputTokens:number\|null,outputTokens:number\|null,estimatedCostUsd:number\|null` | Contributor; `activityItem` |
| `tag.create` / `collection.create` | `name` | Maintainer; `tag` / `collection` |
| `tag.rename` / `collection.rename` | `id,name,expectedEntityVersion` | Maintainer; matching entity |
| `tag.delete` / `collection.delete` | `id,expectedEntityVersion` | Maintainer; matching entity; remove references transactionally |
| `invitation.create` | `email,role:"maintainer"\|"contributor"\|"viewer"` | Owner; `invitation`; queues email |
| `invitation.revoke` | `invitationId` | Owner; `invitation` |
| `member.role` | `userId,role:Role,expectedEntityVersion` | Owner; `member`; protect last owner |
| `member.remove` | `userId,expectedEntityVersion` | Owner; `member`; protect last owner |
| `workspace.rename` | `name,expectedEntityVersion` | Owner; `workspace` |
| `workspace.delete` | `confirmName,expectedEntityVersion` | Owner, fresh login ≤10 min; `workspace` |

Strings named `reason`/`comment` are ≤8,000 characters;
reason/rationale must be nonblank. Metrics are finite nonnegative numbers, token
counts/latency integers, unknown values null. `note.add`/`run.report` require an
already-published revision in the same prompt; full outputs/variables are excluded.
Tags/collections enforce trimmed case-insensitive unique names per workspace,
preserving display case. Title ambiguity returns candidates; never first match.

## C5. Authentication profile

Use OIDC with a maintained library (`openid-client`); Keycloak is the reference
provider in a reproducible development/CI Compose profile. Implement one issuer
per team server initially, configurable through operator env. Verify issuer,
audience `promptbranch-team-api`, signature/algorithm allowlist, expiration,
subject, authorized client, `sid` and verified email. Never accept an ID token
as API access token. Map `(issuer,sub)` to user ID, not email; do not auto-link
accounts by matching email. Configure the reference provider to include verified
email, auth_time and sid in access tokens. Membership roles come from Postgres,
not identity-provider realm roles or client input.

Reference clients: confidential `promptbranch-web`, public
`promptbranch-desktop`, public `promptbranch-cli`. Desktop uses external-browser
authorization code + S256 PKCE, nonce/state, loopback literal-IP callback with an
ephemeral port and a single-use 5-minute transaction. CLI uses provider device
authorization grant with interval/slow_down/expiry handling. Provider tokens:
access lifetime 5 minutes, refresh rotation enabled, offline session maximum
30 days; expired/reused refresh token requires login. These values are reference
configuration, not a promise that arbitrary issuers match automatically.

Web is a BFF: browser receives only an opaque 256-bit session cookie, HttpOnly,
Secure, SameSite=Lax, Path=/, `__Host-pb-team`. Hash cookie IDs at rest; encrypt
provider refresh tokens with an operator-managed AES-GCM key outside the DB.
CSRF token plus same-origin Origin validation on cookie-authenticated mutations.
No cookies are set by anonymous snapshot routes. Native and agent API calls use
Bearer only. Reject requests supplying both auth modes.

Persist a revocable application session keyed by validated `(issuer,sub,sid,clientId)`;
first valid login creates it. A revoked key can never auto-register again; a fresh
IdP login must produce a new sid. Check user active status, session revocation,
workspace membership, generation and token scope on every request, not only JWT
expiry. Human logout calls app session revocation and provider revocation. Account
logout-all invalidates all app sessions and all personal agent tokens. Implement
OIDC backchannel logout or introspection as a later IdP integration unless already
supported; v1 does not claim instantaneous IdP-admin logout beyond access-token
expiry, while app offboarding is immediate on subsequent requests.

Agent token format `pbt_<publicTokenId>.<32-random-byte-base64url-secret>`; store
only secret hash and metadata. Human sees secret once; idempotent retry returns
`secretAvailable:false` without raw token. If delivery was lost, revoke and mint
a new token. Membership downgrade/removal revokes existing tokens; reinstatement
never revives them. API auth failure is distinct from unavailable network.

## C6. Transactions, idempotency and revocation

All workspace writes first lock the workspace row, then read/lock membership and
target rows in a consistent order. Role changes/removal use the same workspace
lock; whichever transaction acquires it first defines before/after authorization.
Within the transaction: authenticate context, check current permissions and
generation, resolve command receipt, validate expected versions, apply domain
changes, append audit, allocate catalogue sequence only for catalogue changes,
write feed event, persist receipt, commit. No network I/O inside this transaction.

Receipt key `(workspaceId,principalId,commandId)`; `principalId` distinguishes an
agent token from its owner. Store canonical request hash including generation.
Same ID+same request returns original receipt; different request returns
COMMAND_ID_REUSED. Keep receipts for workspace lifetime (pilot quota applies).
Only successful mutations produce receipts; failed preconditions consume no ID.
Clients never change payload under an existing ID. Workspace creation/acceptance
use equivalent user-scoped receipts. Invitation email uses a transactional job
outbox, not send-before-commit. All emitted IDs/timestamps are server-authored.

Every membership role change/removal/re-add rotates `membershipGeneration`.
Removal rejects all requests immediately after commit. Re-add requires fresh
bootstrap and deliberate resubmission of old drafts with new command IDs; old
queued mutations cannot silently regain permission. `serverEpoch` and generation
must match on bootstrap/feed/commands; generation mismatch returns MEMBERSHIP_CHANGED.
Writes' epoch is sent as `X-PromptBranch-Team-Epoch`. WORKSPACE_FORBIDDEN requires
client to quarantine outbox and clear managed cached content, FTS, and in-memory
views. ROLE_FORBIDDEN/SCOPE_FORBIDDEN reject that action and refresh current
permissions, without deleting an otherwise authorized catalogue. SESSION_REVOKED
locks that account/principal and clears its managed caches. Ordinary expiry asks
for login; network errors retain offline data. Offline copies cannot be erased
remotely. User-owned draft recovery is quarantined, never auto-uploaded; allow
local discard/export with an explicit privacy explanation.

## C7. Catalogue bootstrap and change feed

Catalogue includes only prompts, published revisions, tags and collections.
It excludes drafts, candidate revisions, proposals/comments, run/note activity,
membership PII, API keys, sessions and public delete tokens. Collaboration lists
are authorized live reads; do not persist them in the offline catalogue.

Use a transactional per-workspace sequence counter locked with workspace writes;
do not use a global sequence/MAX(id) as a commit-order cursor. A Change groups
the entire logical catalogue mutation, e.g. revision publication and approved
pointer movement. Deleting a tag may affect many prompt references: store a
compact tombstone event with tag ID and deterministic cascade semantics rather
than exceeding the 512 KiB response cap. Client cascades delete references to
that tag/collection within the same transaction. Server publishes all dependencies
needed for a prompt pointer; client defers FK enforcement to transaction end.

Bootstrap POST creates a materialized immutable catalogue snapshot in a
repeatable-read transaction while locking its workspace, and captures highWater
from that same state. Store rows server-side incrementally with SQL, not one
unbounded JSON array in app memory. Snapshot bound to user/principal, workspace,
generation and epoch; expires after 10 minutes. Bootstrap POST reuses a still-valid
snapshot for the same principal/workspace/generation/epoch, returning 200; otherwise
it replaces any expired snapshot and returns 201. Opaque signed page tokens bind
snapshot/offset; no long-lived DB transaction across HTTP calls. Check current
membership on every page. Client writes staging tables, validates hashes and
references, then atomically swaps catalogue and cursor to highWater. Outbox and
private drafts survive a resnapshot. Never expose partial bootstrap as complete.

Feed returns complete changes with `seq > after`, in commit order; nextCursor
equals last returned seq (or after if none). An empty catalogue event is not
emitted for comments/memberships; access is checked before feed lookup. Retain
changes for 30 days. `after < minimumRetainedCursor` returns CURSOR_EXPIRED;
bootstrap again. Future/foreign/malformed cursors are VALIDATION_FAILED. On
duplicate delivery, applying `(serverId,workspaceId,seq)` twice is a no-op.
Catalogue row updates and cursor advancement commit atomically. Don't trust
client clock, HLC, revision number or a claimed approved flag.

Desktop polls selected workspace every 15 seconds while foreground, other joined
workspaces every 60 seconds while running, and immediately on focus/reconnect or
explicit refresh, with jitter. No background network promise when app is closed.
CLI/MCP default to online approved reads; `--offline` or explicit MCP offline
configuration permits cached reads carrying `{source:"cache",lastSyncedAt}`.
An exact revision cache read is still labeled cached; “latest approved” cannot
be asserted offline. Reads and writes never fall back to Personal on an error.
Native/cache namespaces include canonical origin, serverId, userId, principalId
and workspaceId. Human and agent credentials, and two distinct agent credentials,
never share a cache or outbox. Agent online initialization uses `/principal`;
offline mode needs a previously initialized matching profile. It does not imply
that current server permission was revalidated while disconnected.

## C8. Invitations, limits, data lifecycle

Invites expire in 7 days, are single-use 256-bit random tokens stored hashed,
and bind to the invited normalized verified email. No provider-specific alias
rewriting (`+`/dots). Identity provider verifies addresses; normalization is trim
and lower-case for comparison. Token appears only in email's first-party accept
URL, with no third-party assets, no-referrer, no analytics or token logging.
GET never consumes the invitation (email scanners must be safe); explicit POST
consumes it after verified login. Revoke/resend invalidates old tokens. Last owner
cannot be removed/demoted; make another member owner first. Invitation cannot
grant owner directly. Delete a workspace: soft-disable immediately, revoke tokens,
stop jobs, and purge domain data after 30 days; audit retention 90 days, then purge.

Pilot quotas: 50 members/workspace, 5,000 prompts, 200 MiB published revision
content/workspace, 50,000 proposals, 20 active tokens/member/workspace. Defaults
are configuration with max values advertised through info; enforce in database
transaction, not optimistic UI. Human/agent reads 300/minute/principal/workspace,
writes 60/minute; invitations 20/hour/workspace; auth edge limits by IP. Use
Postgres counters for shared rate limits; keep anonymous snapshot limits separate.
Revisit limits from measured load, not before first pilot.

Secret scan server-side on new team content/comments/notes/run-summary text:
high findings block with SECRET_BLOCKED, medium findings require client preview
but do not block server writes. Reuse scanner without exposing matched secrets
in error messages/logs. No provider keys/variables/full outputs auto-upload.
Owner export includes catalogue, collaboration, members and audit with a manifest
and checksums, excluding all credentials. Workspace deletion and account deletion
must first transfer last-owner responsibilities; self-service account deletion
anonymizes displayed identity while retaining actor IDs until workspace retention
permits removal. Implement `DELETE /me` with fresh login and confirmed email,
and `POST /sessions/revoke-all`; both human-only and CSRF-protected for web.

## C9. Ownership, fixtures and integration gates

Main PromptBranch owns `packages/team-contract`: Zod schemas, TypeScript types,
OpenAPI 3.1 `openapi.json`, canonical fixture JSON, compatibility tests and a
Node mock server via exported subpath `@promptbranch/team-contract/testing`.
Runtime root has no Electron, database, HTTP framework, or Node-only dependencies.
Generate/check OpenAPI from schemas with tests; do not hand-edit divergent DTOs.
Fixtures: `catalog.seed.json`, `catalog.changes.json`, `proposal.lifecycle.json`,
`errors.json`, `membership-revocation.json`; cover all DTO/operation/error variants.
Mock launcher: `pnpm --filter @promptbranch/team-contract mock --port 4318`.
It binds loopback and uses synthetic bearer tokens; it is never deployable auth.

Portal pins the exact packed/published version and runs those fixtures against
real route handlers and PostgreSQL. For parallel development use `pnpm pack` to
produce a checksum-recorded tarball and `pnpm add <absolute-tarball>` locally;
do not commit absolute file dependencies. Before merge replace with the exact
registry version, or a reviewed immutable package artifact accessible to CI.
Publishing/installing a registry artifact is a separate release action, not a
reason to block local implementation. Portal must not copy/reimplement schemas.

Gate G0: same contract version/hash + fixture acceptance on both sides.
G1: real OIDC web/desktop/CLI authentication and scoped identity match.
G2: native and browser proposal -> independent review -> feed -> native read.
G3: crash/retry/concurrency/offboarding/epoch reset with no data leak/lost edit.
G4: legacy personal sync/share regression and real device/packaged-app smoke.
G5: backup/restore, staged upgrade, operations and pilot acceptance.

## C10. Normative examples and verification

Reference local integration environment: Portal `http://127.0.0.1:4317`, contract
mock `http://127.0.0.1:4318`, PostgreSQL published only on `127.0.0.1:54329`,
Keycloak `http://127.0.0.1:48080/realms/promptbranch-dev`, SMTP capture
`127.0.0.1:48025`, capture web UI `127.0.0.1:48026`. Container-to-container
addresses differ but advertised issuer must be exactly reachable/matched from
browser, native client and API validator; use host networking mapping/proxy
deliberately and test issuer equality. Never substitute a different issuer just
to make container DNS work. Server uses stable synthetic UUID serverId/epoch
from fixture manifest; fixtures emit all entity IDs to a local ignored JSON file.
Ports may be overridden together through the harness, never hardcoded differently
between apps. Production requires HTTPS and separate non-test identity config.
In the reference development setup, run Portal through pnpm on the host; Compose
runs dependency containers only. This makes the advertised loopback issuer the
same for browser, Portal Node process and native client without container DNS
rewriting. Production-container smoke uses its configured HTTPS issuer.

Smoke artifact manifest fields: `protocol`, `contractVersion`, `contractSha256`,
`mainCommit`, `portalCommit`, `serverId`, `serverEpoch`, `fixtureIds`,
`runtimeVersions`, `imageDigests`, `gateResults`, `commands`, `recordedAt`.
It never contains bearer/refresh/invitation tokens, real email addresses or content.

Reference nonfunctional pilot targets (measure, don't assume): seeded workspace
of 1,000 prompts/10,000 approved revisions, 20 active members, 2 vCPU/4 GiB team
app plus separately provisioned Postgres; p95 approved read/search ≤500 ms and
command acceptance ≤1 s excluding external auth/network. Bootstrap 10 MiB
catalogue completes within 60 s over local test network without unbounded memory.
Healthy online second client receives approved changes within 30 s. Record dataset,
host resources and deviations; fix unbounded queries/response growth before G5.
These are launch acceptance targets, not advertised SLA or a capacity guarantee.

```json
{
  "commandId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "membershipGeneration": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "operation": {
    "type": "proposal.submit",
    "promptId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "baseRevisionId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "content": "Summarize the issue, evidence, and next action.",
    "rationale": "Make the expected response structure explicit.",
    "supersedesProposalId": null
  }
}
```

Contract tests require schema-valid examples and invalid cases for each union
member. Reference privacy test: seed public revision A plus candidate B containing
`unapproved-secret-marker`; read browse/search/exact-revision/bootstrap/feed as
viewer and agent. B must appear nowhere, including counts or snippets. Reviewer
may obtain B only from proposal detail. Reference concurrency test: two proposals
base A; approve B, then attempt approval C with expected A; second returns
STALE_BASE and leaves B current, C open. Rebase C produces a new proposal on B.

Reference idempotency test: drop first submit response after commit; resend the
same command; same proposal ID, one audit record, one receipt. Remove membership
and retry again: 403, never receipt data. Reference feed test: pause transaction
before commit; another mutation cannot overtake its workspace sequence; bootstrap
plus subsequent feed contains each committed update exactly once.

Primary technical references checked on 2026-09-21:
[native OAuth/PKCE](https://www.rfc-editor.org/rfc/rfc8252),
[openid-client](https://github.com/panva/openid-client),
[Keycloak OIDC and device flows](https://www.keycloak.org/securing-apps/oidc-layers),
[Postgres isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
Exact dependency patches/container digests are resolved and locked at task start;
do not assume today's docs establish compatibility with the installed runtime.
