# Gate ledger — Portal team workspaces (P0/P1)

Branch `feature/teams-portal`. Baseline `89665ff` (reviewed baseline, clean).

## Record: 2026-09-21, P7 complete

Commits:

- `feat(portal): add team workspace browser experience` (P7)

Scope delivered:

- SSR foundation: `lib/team/ssr.ts` (cookie → principal → domain services
  directly; no loopback HTTP, no second authz), readable `pb-team-csrf`
  companion cookie (double-submit against the session's stored hash, cleared
  on logout/revoke-all), `csrf-client.ts` fetch helper carrying protocol +
  CSRF + epoch headers for every browser mutation.
- Pages: `/team` picker (+empty state), `/team/new`, workspace-aware shell
  layout (role badge, Library/Proposals/Members/Settings nav gated by role,
  theme toggle, sign-out clearing per-tab drafts), library with
  search/tag/collection/archived filters + maintainer seed form, prompt
  detail (approved content + hash + verbatim copy + IDs-only
  promptbranch:// deep link + published history), proposals list with
  status tabs, proposal editor (sessionStorage per-tab drafts keyed
  workspace+prompt+base, live diff, download-recovery, beforeunload warning,
  submit → immutable candidate), proposal detail (candidate hash/version,
  stale-base rebase path, SELF_REVIEW banner, distinct-reviewer review
  actions binding exact candidate, withdraw-own, append-only discussion),
  settings (members/roles/invites with last-owner UI disable + revoke,
  agent tokens mint/revoke with one-time-copy warning, metadata-only
  audit, rename + fresh-login/confirm-name delete), `/team/account`
  sessions, `/team/invitations/accept` (GET previews, POST consumes;
  login honors a sealed same-site `next` landing).
- Tests: portal 168 (page-level: unauthenticated redirect, hostile-title
  escaping, candidate invisibility on detail, IDs-only deep link, viewer
  CTA hidden, owner-only nav hidden). All gates green.

**Browser gate satisfied with a real drive through the local Keycloak**:
alice created a workspace → seeded a prompt → submitted a proposal (and saw
the SELF_REVIEW guard) → invited bob (email delivered by the worker to
Mailpit, token extracted from the captured body) → signed out → bob signed
in → accepted the invitation via the emailed link (GET preview + POST
accept) → approved alice's proposal with a review comment → the database
confirms the approved head moved to the new revision.

Integration findings (fixed or noted):

- Next dev blocked HMR for the 127.0.0.1 origin (hydration never ran):
  `allowedDevOrigins: ["127.0.0.1"]` added.
- Embedded-webview canonicalization to `localhost` split cookies across
  host spellings and looped the OIDC callback; the dev realm now registers
  both loopback spellings on the web client and the drive ran on
  `localhost:4317`.
- Every browser command form must carry BOTH the epoch header and the
  membershipGeneration in the envelope (found live: seed 422, invite 422).
- KNOWN GAP (P9): `scripts/team-worker.mjs` runs the built dist, whose
  `@promptbranch/share` import resolves to TS source outside Next — worker
  CLI needs share's exports to point at built output (delivery in tests
  uses the TS path).

Next: P8 — privacy boundaries, authorization matrix and abuse controls.

## Record: 2026-09-21, P6 complete

Commits:

- `feat(agents): add revocable workspace capabilities` (P6)

Scope delivered:

- `auth/agent-tokens.ts`: `pbt_<id>.<256-bit-secret>` tokens (secret hashed
  at rest, shown exactly once); minting service with receipt-based
  idempotency (replay → `secretAvailable:false` without a second row),
  catalog:read forced into every scope set, viewers limited to read-only
  scopes, 20-active-tokens quota, 1–90 day expiry; `resolveAgentBearer`
  validates in constant time and re-checks expiry, revocation, owner
  account status, workspace binding and the generation invariant (a
  rotation that somehow missed revocation still fails closed); listing
  (own, or all for the owner) and final revocation.
- Dispatch agent path: fixed operation allowlist (proposal.submit/withdraw,
  comment.add, note.add, run.report — everything else ROLE_FORBIDDEN),
  scope intersection (SCOPE_FORBIDDEN), owner-role floor and generation
  binding before any receipt lookup; agents comment on/withdraw only their
  OWN proposals; the self-review guard resolves an agent proposal to its
  owner human. Portal read floors cap agents at viewer-level surfaces —
  members/invitations/audit/export stay human-only regardless of role.
- `domain/activity.ts`: note.add/run.report bound to already-published
  revisions (enforced by the P1 composite FKs — candidates and cross-prompt
  targets cannot store activity), finite non-negative metrics or null,
  secret-scanned bodies, no feed emission; activity reads are
  contributor+ for humans and own-items-only for agents.
- Routes: `GET/POST /workspaces/:w/agent-tokens`, `DELETE
  /workspaces/:w/agent-tokens/:id`, `GET /workspaces/:w/activity-items`;
  `/principal` serves agent identity (`agent:<tokenId>` + scopes), `/me`
  stays verified-human-only, `/workspaces` returns exactly the token's
  workspace for agents, and proposal list/detail filter to the agent's own.
- Tests: team-server 92 (mint once/replay/quota/viewer rule, bearer wall —
  wrong secret/expiry/revocation/wrong workspace/downgrade/generation,
  dispatch allowlist, scopes, own-proposal rules, SELF_REVIEW via agent
  then approval by a different maintainer, notes/runs validation +
  published-only + no-feed + visibility split, raw-secret scan across all
  team tables); portal 162 (HTTP mint/replay/list/revoke, /principal for
  agents, /me 401, mixed auth 401, agent catalogue reads, human-only
  member surfaces, activity visibility). All gates green.

Pending (main repo): spawning the real PromptBranch CLI/MCP binaries
against the local service (plan P6 task 5) — recorded like G1's native
legs until the main repository delivers built clients.

Next: P7 — browser workspace application (largest remaining phase).

## Record: 2026-09-21, P5 complete

Commits:

- `feat(sync): serve consistent team catalogue changes` (P5)

Scope delivered:

- `sync/changes.ts`: per-workspace sequences allocated from
  `next_catalog_seq` under the workspace row lock (the same lock every
  mutation takes) so sequence order and commit order can never disagree —
  proven by the two-connection test (an uncommitted allocation blocks later
  ones and stays invisible to readers). Feed reader enforces cursor rules:
  malformed/future → VALIDATION_FAILED, below the retained floor →
  CURSOR_EXPIRED, byte-bounded pages that never split a record, byte-stable
  payloads for duplicate delivery.
- `sync/catalog-records.ts`: CatalogRecord SQL builders (prompt/revision/
  tag/collection per contract §C3) used both by the feed and the bootstrap;
  candidates are structurally absent (publications join).
- Dispatch wiring: catalogue commands now emit grouped events in the
  mutation transaction — approval lands revision + head movement in ONE
  event; seeds emit prompt + revision; tag/collection deletes emit compact
  cascade tombstones; comments/membership/invitation commands emit nothing.
  Receipts carry the real `catalogSeq` (stored internally in the receipt
  payload so replays report the original sequence; clients see {kind,id,…}).
- `sync/bootstrap.ts`: repeatable-read materialization under the workspace
  lock with highWater captured from the same state; SQL INSERT … SELECT for
  rows (no app-side buffering); reuse-until-expiry (200) vs replace (201);
  HMAC-signed page tokens bound to snapshot+offset (`sync/cursors.ts`,
  TEAM_CURSOR_SIGNING_KEY or domain-separated derivation from the session
  key); access/epoch/generation rechecked on every page.
- `sync/retention.ts` + worker: bootstrap rows expire after 10 minutes,
  events after 30 days; the minimum valid cursor (floor = newest deleted
  sequence — a client AT that cursor lost nothing) advances transactionally
  with the deletes, so pruning can never manufacture a gap.
- Migration `004-team-sync-retention.sql` (min_retained_seq column).
- Portal routes: `POST /workspaces/:w/bootstrap` (201/200), `GET
  /workspaces/:w/bootstrap/:s` (paged, signed tokens), `GET
  /workspaces/:w/changes` (epoch/generation rebinding enforced).

Tests: team-server 86 (grouped approval event, candidate-invisible-until-
approval, tombstones, no-event commands, commit-order two-connection
invariant, cursor matrix, retention floor, bootstrap lifecycle: reuse/
replace/expiry/paging/tamper/foreign-principal/membership+epoch rechecks);
portal 160 (bootstrap→page→change-stream happy path, 201-vs-200 reuse,
MEMBERSHIP_CHANGED on stale generation, future-cursor 422). All gates green
including `pnpm team:migrate` applying 004 against the live stack.

Deferred (as planned): main-repo D3 consumer fixtures against these routes
are pending the contract artifact (recorded like G1's native leg); feed
bootstrap/changes expiry as enqueued jobs (the worker's per-tick sweep
covers the same retention semantics now); `X-PromptBranch-Team-Epoch`
response headers on feed reads arrive with P8's header sweep.

Next: P6 — scoped agent tokens, notes and run summaries.

## Record: 2026-09-21, P4 complete

Commits:

- `feat(team): add immutable revisions and reviewed changes` (P4)

Scope delivered:

- `content/scan.ts`: the packages/share rule set enforced server-side on
  every new team text (seed content/metadata/change notes, proposal
  content/rationale, review comments, discussion comments); high →
  SECRET_BLOCKED with redacted field/rule/line findings, medium ride along
  on the dispatch response for client preview; 64 KiB UTF-8 content ceiling.
- `commands/operations.ts`: full P4 union (prompt.create/metadata/archive/
  restore/rollback, proposal.submit/withdraw/review, comment.add,
  tag/collection create/rename/delete) with C2 field limits; role floors
  corrected to the C4 table (owner-only membership/invitation/workspace ops
  retained; maintainer for prompt/review/organization; contributor for
  submit/withdraw/comment).
- Domains: `revisions` (immutable candidates, server-computed contentHash),
  `prompts` (deferrable-FK atomic seed, metadata with expected versions,
  archive/restore semantics, publication-verified rollback, tsvector search
  projection maintained in-mutation from title/description + APPROVED head
  only, browse/detail/history/exact-revision reads), `proposals`
  (submission never writes publication/search rows; supersession closes the
  old proposal atomically; review enforces open-status + version + exact
  candidate id/hash + distinct human author (SELF_REVIEW incl. agent-owner
  case) + head=base=expected → STALE_BASE; reject never moves the head;
  terminal states refuse further mutations; append-only comments),
  `organization` (case-insensitive unique tags/collections, junction
  cascades, cross-workspace ids rejected by composite FKs).
- Portal routes: prompts list/detail/history, revisions/:r, tags,
  collections, proposals list/detail (the only candidate-visible surface,
  contributor+) and comments, all member/role-gated via requireMemberRole.

Tests: team-server 76 (seed/search, secret scan, self-review, exact
candidate binding, concurrent-approval STALE_BASE + rebase via supersession,
terminal states, archive restrictions, rollback, tag collisions/cascades,
candidate privacy across search/history/exact-revision/detail); portal 159
(HTTP catalogue authorization, viewer refused on collaboration surfaces,
candidate invisible everywhere but proposal detail, foreign workspace 403).
All gates green.

Deferred (as planned): catalogue sequence/feed emission and bootstrap (P5);
agent-authored submissions + notes/run summaries (P6); browser UI (P7);
`mediumFindings` rides as a forward-compatible extra field until the D0
contract fixes its home.

Next: P5 — consistent catalogue bootstrap and resumable change feed.

## Record: 2026-09-21, P3 complete

Commits:

- `feat(team): add workspaces invitations and member authorization` (P3)

Scope delivered:

- `commands/`: `operations.ts` (strict Zod for the P3 subset of the PB-TEAM-1
  operation union — invitation.create/revoke, member.role/remove,
  workspace.rename/delete — marked for replacement by the D0 contract
  artifact at G0), `receipts.ts` (canonical-JSON request hashes covering the
  full envelope + generation; workspace- and user-scoped receipts;
  COMMAND_ID_REUSED on payload drift), `dispatch.ts` (authz + generation
  before any receipt lookup, epoch header check, audit + receipt in the
  mutation transaction, catalogSeq "0" for non-catalogue commands).
- `domain/`: authorization (fresh membership rows under lock), workspaces
  (idempotent create, fresh reads, rename, fresh-login + confirm-name soft
  delete with 30-day purge and job cancellation), memberships (generation
  rotation on role change/removal/re-add, agent-token revocation on
  downgrade/removal, last-owner protection), invitations (256-bit hashed
  tokens, 7-day expiry, identity-bound idempotent acceptance, revoke+create
  resend, 20/hour/workspace transactional quota), audit (append-only,
  metadata-only).
- `jobs/`: transactional outbox (AES-256-GCM payloads), invitation email via
  nodemailer (first-party accept URL only), SKIP LOCKED claiming, retry
  ladder 1m/5m/30m/2h, payload secret cleared on success; `pnpm team:worker`
  loops `runDueJobs` (refuses non-loopback SMTP unless overridden).
- Portal routes: workspaces GET/POST (+201/200 idempotency), :w GET,
  members/invitations/audit owner-only reads, invitations/accept POST,
  :w/commands POST with the X-PromptBranch-Team-Epoch header; read-side
  `requireMemberRole` helper; 256 KiB content-length pre-checks on POSTs.

Tests: team-server 63 (permissions matrix × every op, last-owner race from
two concurrent commands, removed-member replay-before-receipt, generation
semantics + re-add, epoch mismatch, invitation expiry/revoke/identity,
quota, receipts idempotency/reuse, outbox SKIP LOCKED + ladder, real Mailpit
delivery with token-absence scan across every team table); portal 158
(HTTP role matrix, foreign 403-without-metadata, 404 unknown, receipt
replay over HTTP, CSRF, invitation flow). All gates green (typecheck, test,
build, whitespace).

Notes / deferred:

- Non-catalogue commands return `catalogSeq: "0"` (sequence allocation is
  P5); fixture-confirmed semantics arrive with the D0 artifact.
- Invitation *delivery status* surfacing (job outcome per invitation) needs
  an invitation_id column on team_jobs — planned as migration 004 with the
  P7 UI that displays it.
- Distributed rate buckets (P8) supersede the transactional invitation
  quota; duplicate-command quota separation also lands in P8 (receipts
  already make safe retries free).

Next: P4 — approved libraries, immutable revisions and collaboration.

## Record: 2026-09-21, P2 complete

Commits:

- `feat(auth): add verified team accounts and sessions` (P2)

Scope delivered:

- `packages/team-server/src/auth/`: `crypto.ts` (AES-256-GCM SecretBox,
  constant-time compares), `oidc.ts` (jose access-token validation — issuer/
  audience/alg/azp allowlist, ID-token rejection, verified email + sid
  required; openid-client web code+PKCE flow with cached discovery), `principal.ts`
  (server-authored principal ids), `sessions.ts` (issuer+sub account mapping,
  revocable app sessions that can never auto-register a revoked key, opaque
  web sessions with 24h sliding / 30d absolute windows, encrypted refresh
  tokens, session management, fresh-login + last-owner-protected account
  deletion, per-session refresh single-flight).
- Portal `src/lib/team/{env,service,auth,csrf,http}.ts` + routes:
  `/api/team/v1/{info,me,principal,sessions,sessions/[id],sessions/revoke-all}`
  and `/team/auth/{login,callback,logout}` (BFF, `__Host-pb-team` cookie,
  sealed single-use correlation cookie, CSRF + same-origin on cookie
  mutations, login/callback rate limits).
- Tests: team-server auth suite (19 new, real PG) and five portal suites
  (info shape/headers, bearer negative wall, sessions management, web cookie
  + CSRF/logout, anonymous-surface no-cookie). 40 + 154 tests total.

**G1: PARTIAL — web leg verified.** Real browser OIDC login against the local
Keycloak completed end-to-end (S256 PKCE + state + nonce, code exchange,
opaque cookie, `/api/team/v1/me` returning Alice's identity; live checks: 426
without protocol header, stable 401 body, one active web session row in
PostgreSQL). Desktop/CLI legs wait on the main PromptBranch clients (D10).

Live-smoke findings (all resolved in code):

- openid-client v6 is HTTPS-only by default; discovery passes
  `allowInsecureRequests` only for loopback HTTP issuers (contract C10).
- Authorization URL must carry `code_challenge` + `code_challenge_method:
  "S256"` — sending the verifier (or omitting the method) fails every
  exchange with "PKCE verification failed: Code mismatch".
- The callback rebuilds its URL on `TEAM_PUBLIC_ORIGIN` before the token
  exchange so host-spelling rewrites (127.0.0.1 ↔ localhost) cannot break
  redirect_uri matching. In-app-browser display showed `localhost` while the
  cookie lived on `127.0.0.1` — cookie host isolation behaved correctly.
- Keycloak ID tokens carry `sub/sid/email_verified/auth_time`; whether
  *access* tokens also carry `auth_time` is unverified (native-client smoke
  pending) — the validator falls back to `iat` per C5's reference-config
  wording. Verify at desktop/CLI smoke time.

Checks: `pnpm typecheck` ✅ · `pnpm test` ✅ (64 share + 40 team-server +
153 portal, 1 skipped G0) · `pnpm build` ✅ · `git diff --check` ✅ ·
live smoke ✅ (web leg).

Next: P3 — workspaces, memberships, invitations and audited command dispatch
(uses this Principal/session foundation; role matrix + idempotency receipts).

## Record: 2026-09-21, P0 + P1 complete

Commits:

- `583a4cf` feat(team): establish contract and local stack (P0)
- `95717aa` feat(team): add transactional PostgreSQL storage (P1)

Contract:

- Accepted specification: PB-TEAM-1, `contractVersion 1.0.0`, protocol 1
- SHA-256: `4264f958df5262486c2eff1c364b4c88056e7eea3b39aacf9266cdb797b0a5ce`
  (docs-internal/contracts/PB-TEAM-1.md + .sha256; verified byte-identical to
  the copy embedded in the implementation plan and to the handoff file)
- **G0: integration pending** — the owned `@promptbranch/team-contract` D0
  artifact has not arrived. No DTO schemas were forked; the pending-aware test
  (`apps/portal/tests/team-contract.test.ts`) auto-upgrades when the artifact
  is installed. Completing G0 requires: exact artifact (tarball or registry
  version) + its fixture set, verified against the SHA-256 above.

Checks (all pass unless noted):

| Command | Result |
|---|---|
| `pnpm team:dev:up` | pass — postgres/keycloak/mailpit healthy, realm reconciled |
| `pnpm team:migrate` | pass — 3 migrations; re-run idempotent |
| `pnpm team:fixtures` | pass — loopback/synthetic guard; exit 2 "G0 pending" (expected) |
| `pnpm typecheck` | pass — share, team-server, portal |
| `pnpm test` | pass — share 64, team-server 21, portal 128 + 1 skipped (G0 artifact) |
| `pnpm test:team` | pass — 21 real-PostgreSQL tests |
| `pnpm build` | pass — Next.js standalone production build |
| `git diff --check` | clean |

Pinned images (checked for release/security support 2026-09-21):

- postgres:18.4-alpine3.24 @ sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
- quay.io/keycloak/keycloak:26.7.4 @ sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c
- axllent/mailpit:v1.31.2 @ sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d

Keycode discoveries (context for reviewers):

- PostgreSQL 18 container images moved the data dir to `/var/lib/postgresql`;
  mounting `/var/lib/postgresql/data` refuses to start (compose volume fixed).
- Keycloak 26.7 `--import-realm` registers standard client-scope NAMES but
  never materializes the scopes, and its validator rejects
  `http://127.0.0.1:*`; `scripts/team-keycloak-init.mjs` therefore builds the
  realm through the admin API (standard scopes copied from a throwaway probe
  realm, desktop client registered separately).

Deviations / decisions:

1. Realm bootstrap via admin API instead of `--import-realm` (forced by the
   KC 26.7 import defects above); `pnpm team:dev:up` chains it, idempotent.
2. `scripts/team-keycloak-init.mjs` added (not in the plan's file list) —
   required to satisfy C5 token claims (`auth_time`, `email_verified`).
3. Scratch test databases are owned by `team_migrate` (PG15+ public-schema
   CREATE rule); dev-only `team_admin` superuser creates/drops them.
4. `deploy/team/.env.example` synthetic dev credentials double as harness
   defaults (explicitly local; CI overrides via env). `deploy/team/.env` is
   git-ignored.
5. Full schema (all tables from the plan's normative minimum) shipped in
   migrations 001–003 as the storage foundation; domain services arrive P2+.

Next: P2 (OIDC accounts, web sessions, device-session revocation) — blocked
only on nothing; can start immediately, but G0/G1 verification needs the D0
contract artifact and real client smoke. Then P3.
