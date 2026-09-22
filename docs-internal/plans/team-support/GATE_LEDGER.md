# Gate ledger — Portal team workspaces (P0/P1)

Branch `feature/teams-portal`. Baseline `89665ff` (reviewed baseline, clean).

## Record: 2026-09-22, P10 complete (portal side)

Commits:

- `feat(pilot): add team benchmark, CI lane and integration readiness` (P10)

Scope delivered:

- **Gap fix found in review**: contract C8 also caps READS at 300/minute/
  principal/workspace — the P8 ledger note ("reads not in the shared
  list") was wrong. `requireMemberRole` now consumes a shared PG bucket,
  covering every JSON read route AND SSR page loads with one key.
- **`scripts/team-benchmark.mjs`** (`pnpm team:benchmark`): seeds a
  synthetic workspace (1,000 prompts / 10,000 published revisions via SQL,
  20 agent clients minted directly with sha256-at-rest secrets), then
  drives a REAL server: p50/p95 approved read + search under 20
  concurrent clients, command acceptance (proposal.submit), full
  catalogue bootstrap (pages via signed tokens), and second-client feed
  visibility (catalogue write via a forged owner web session over real
  HTTP with the CSRF pair — proposals never enter the feed, so the probe
  uses prompt.create). Loopback origins only; synthetic markers
  everywhere; idempotent pre-clean + product-lifecycle cleanup (purge
  sweep). Exits non-zero on a contract-target miss.
  **Production-mode run (next build + start, local network): read p95
  63 ms, search p95 37 ms, command p95 8 ms, bootstrap 6.6 s for
  28.5 MB, feed visibility 37 ms — ALL targets met.** A dev-mode run
  misses read p95 (707 ms) from instrumentation overhead — dev numbers
  are not acceptance evidence; run production mode.
- **`scripts/team-integration.mjs`** (`pnpm team:integration`): the G-gate
  receipt — branch/commit, contract SHA (4264f958…), migration chain,
  package versions, 5 digest-pinned images, and per-gate status: G0/G2/G3
  **PENDING** (require the main repo's D0 artifact and D10 built clients —
  never claimed from portal-side tests), G1 PARTIAL (web leg verified),
  G4 READY-CANDIDATE, G5 NOT-STARTED.
- **CI lane** (`.github/workflows/ci-team.yml`): real PostgreSQL 18.4
  service container (same digest as the dev stack) with the
  postgres-init role split recreated, inline-JWKS synthetic identity
  (no Keycloak container needed), full suite + explicit `pnpm test:team`
  + build; triggers on PRs/pushes to main AND dev. Team suites fail
  loudly when the database is absent (by design).
- **User docs**: public `docs/sharing/team-workspaces` page (roles table,
  browser/member/admin behavior, agent tokens, privacy model, offline
  copies, deletion semantics — advertised features only) wired into
  DOCS_STRUCTURE; sitemap/llms listings updated (crawl-exclusion tests
  now assert actual `/team` paths, not substrings, since the public docs
  page legitimately contains "team" in its slug).
- **Rollout/rollback policy + readiness table** appended to
  `deploy/team/README.md` (staged rollout, disabled-by-default public
  flag, pilot metrics without content analytics, two-week defect-free
  criterion, rollback = disable + compatible image, never reverse
  migrations).

Gates: typecheck ×3, full suite (share 64, team-server 104, portal 226),
recursive build, `git diff --check` — all green; benchmark verified live
in production mode.

Remaining (main-repo artifacts, recorded pending in every receipt):
G0 D0 contract artifact, G2/G3 real-client roundtrip and fault scenarios
against D10 binaries, D3 consumer fixtures. The PR into `dev` with the
exact remaining gates is the final step once those arrive.

## Record: 2026-09-22, P9 complete

Commits:

- `feat(ops): add team lifecycle and recovery controls` (P9)

Scope delivered:

- **Deletion lifecycle** (`domain/purge.ts`): due-scan purge of soft-deleted
  workspaces' content 30 days after deletion (child-before-parent FK order,
  prompt heads nulled first), 90-day audit retention, tombstone reclamation
  only after all of its audit ages out. Idempotent; runs on every worker
  tick alongside the retention sweep. Purge is a due-scan rather than an
  enqueued per-workspace job — same guarantees, simpler restart semantics
  (deviation recorded below).
- **Account deletion**: revokes the user's agent tokens and anonymizes
  identity (`Former member` / `former+<id>@deleted.invalid`) while actor
  ids stay valid for audit; revision rows never carried denormalized
  name/email copies by design.
- **Owner export** (`domain/export.ts` + `POST /workspaces/:w/export`,
  `GET .../export/:id`): NDJSON portability snapshot materialized under the
  workspace lock in repeatable read (bootstrap pattern), manifest with
  schema version/counts/high-water, per-record sha256 over canonical jsonb
  text (JS-side verifier reproduces PG key ordering and separators), bounded
  100-record pages rechecking ownership EVERY page, 3/hour/workspace quota
  (shared PG buckets), one active export per owner, 10-minute expiry
  (retention sweep purges). Domain content only — sessions, token hashes,
  invitation secrets, receipts and rate buckets never enter a stream.
  Agents are excluded (human owner only).
- **Recovery** (`domain/recovery.ts` + env gate): `TEAM_RECOVERY_MODE=1`
  registers no team service (every route 503; health reports `recovery`).
  `enterRecovery` (scripts/team-restore.mjs): rotates every server epoch,
  revokes all app sessions + agent tokens, wipes bootstraps, moves feed
  retention floors to head (old cursors CURSOR_EXPIRED), cancels queued
  jobs, records provenance in `team_recovery_log`.
  `finishRecoveryWithRoster`: removes memberships the verified roster does
  not confirm; sole-owner workspaces are protected and reported for manual
  resolution. Verified end-to-end: pre-restore token 503 during recovery,
  401/410 after the window closes.
- **Ops surface**: `/api/team/v1/health/ready` (minimal state:
  ok/degraded/recovery/disabled), numeric-only metrics registry + queue
  gauges logged by the worker (no prompt bodies by construction), env
  additions (TEAM_SMTP_URL, TEAM_EMAIL_FROM, TEAM_RECOVERY_MODE — fail
  closed).
- **Scripts**: `team:backup` (pg_dump -Fc | openssl aes-256 stream
  encryption, sha256 sidecar, 30-day retention, optional consistent SQLite
  snapshot), `team:restore` (restore → enterRecovery → roster finish; exit
  code 2 while protected workspaces need manual resolution). Fixed the P7
  gap: `team-worker.mjs` now imports the narrow `dist/jobs/worker.js`
  graph, which has no `@promptbranch/share` dependency — the worker runs
  the built dist as-is (verified live).
- **Deploy**: `team-runtime` Dockerfile stage (pnpm deploy-pruned, plus
  postgresql-client + openssl for in-container backups);
  `deploy/team/compose.prod.yml`: digest-pinned Postgres on an internal-only
  network, explicit `migrate` job, hardened portal (unchanged runner stage,
  team env, SQLite volume kept separate) and worker on the edge plane for
  IdP/SMTP egress; operator runbook (backups, restore/recovery, alerts,
  exports) appended to `deploy/team/README.md`. Compose config validated.
- Migration `005-team-exports-recovery.sql` (team_exports, rows cascade,
  team_recovery_log); migration-chain tests updated for the new file.

Gates: typecheck ×3, full suite — share 64, team-server 104 (+6 lifecycle,
stable ×2), portal 226 (+4 ops) — recursive build, `git diff --check`,
worker live smoke, compose config — all green.

Decisions / deviations:

1. Purge runs as a due-scan on the worker tick (like retention), not via
   enqueued `workspace.purge` jobs — idempotent re-selection replaces lease
   semantics; the job-type union keeps the names reserved.
2. Per-request latency/error-rate percentiles ride on the reverse-proxy
   access logs (documented); the in-process registry covers queue/worker
   gauges. Full metrics plumbing is pilot infrastructure (P10).
3. Keycloak is not shipped in the prod overlay: production requires HTTPS
   and a separately operated IdP (contract C5 note).
4. The benchmark script (`team-benchmark.mjs`) and the CI lane with a real
   synthetic IdP are P10 scope (plan lists them there).
5. Export verification: JS reproduces jsonb canonical text (length-then-
   bytewise key order, `": "`/`", "` separators) — validated against real
   PG output in the lifecycle suite.

## Record: 2026-09-21, P8 complete

Commits:

- `test(team): enforce cross-workspace and private-surface boundaries` (P8)

Scope delivered:

- **Authorization matrix** (`apps/portal/tests/team-boundaries.test.ts`, 41
  tests): every team read route (workspace detail, prompts/prompt/revisions/
  revision, tags, collections, proposals, activity-items, members,
  invitations, audit, changes feed, bootstrap start) × {outsider, foreign
  member, viewer, contributor, maintainer, owner, agent} with exact
  floor/status expectations, `private, no-store` asserted on every response,
  and content-canary leak checks on every body (two workspaces with the
  SAME title; denied bodies carry neither side's content, allowed W1 reads
  never carry W2's). Foreign nested IDs (W2's prompt/revision under W1's
  paths) → 404 with no data; W1 member on W2's real path → 403.
- **Command negatives**: spoofed `actor` envelope fields never grant
  authority (authorization derives from the authenticated principal; no
  invitation row appears); foreign principal cannot replay another's
  commandId; stale epoch header → 410 before state changes; garbage feed
  cursor and garbage bootstrap snapshot id rejected without leaks.
- **Abuse controls (new machinery)**: `packages/team-server/src/domain/rate.ts`
  — fixed-window Postgres counters in `team_rate_buckets` (atomic
  INSERT..ON CONFLICT, per-key stale-window cleanup, retention sweep purges
  expired buckets). Wired: writes 60/minute per principal on the commands
  route AND workspace-create (shared `cmdwrite:` key), invitations
  20/hour/workspace inside dispatch (replays skip; rollbacks release the
  slot). 429 suite proves exhaustion blocks valid commands and never
  affects other principals.
- **Streaming body cap**: `readTeamJsonBody` in `lib/team/http.ts` enforces
  the 256 KiB cap on the request STREAM (chunked bodies carry no
  content-length); replaced all six inline content-length+json() blocks.
  Handler tests + a real-HTTP chunked 413.
- **Bootstrap cap**: `startBootstrap` now supersedes every prior snapshot
  for the principal (1 active per principal/workspace, serialized by the
  workspace-row lock); superseded snapshot ids stop serving pages.
- **Private-page hygiene**: middleware sets `cache-control: private,
  no-store` on `/team` paths; new `app/team/layout.tsx` exports
  `robots: {index: false, follow: false}`. Crawl exclusion pinned by tests:
  sitemap.xml and llms.txt never contain "/team", robots keeps disallowing
  `/api/` (covers `/api/team`), no OG-image routes exist under /team.
- **Real-HTTP suite** (`apps/portal/tests/team-http.test.ts`, 11 tests):
  spawns `next dev --webpack` on :4617 against the scratch PostgreSQL,
  forges a web session straight into the shared DB (same encryption key),
  and drives actual HTTP: protocol gate 426, CSRF double-submit negatives
  (missing/wrong token, cross-origin Origin rejected even with a valid
  token, cookie+bearer combo rejected, valid pair accepted), strict nonce
  CSP (`strict-dynamic`, no script `unsafe-inline`), page privacy, and the
  chunked-body 413.

**Bug found by the matrix and fixed**: agent-token bootstraps returned 503
— `startBootstrap` inserted NULL into `team_bootstraps.principal_user_id`
(NOT NULL). Agents now record their owning member's user id
(`principal_key` still separates agent snapshots from the owner's own).

Verified additionally against a production `next build && next start`:
`/team` serves exactly `cache-control: private, no-store` (the middleware
value ships in production; dev-mode Next overrides HTML responses with its
own `no-cache` instrumentation — the HTTP suite asserts the invariant,
`middleware.test.ts` pins the exact value).

Test-infra hardening: `team-test-setup` cleanup ends the service
singleton's pool and settles before `DROP DATABASE WITH (FORCE)` — under
parallel suite load the terminated sockets surfaced as unhandled errors.

Gates: `pnpm typecheck` (3 packages), `pnpm test` — share 64, team-server
98 (+6), portal 222 (221 + 1 skipped G0; +53) — stable across repeated
runs, `pnpm build`, `git diff --check` — all green.

Decisions / deviations:

1. "writes 60/minute" (contract C8) interpreted as per-principal across all
   workspaces, shared between the commands route and workspace creation.
2. Auth-edge IP limits stay in the pre-existing in-memory limiters on
   /team/auth/login and callback (20/10min, 30/10min); the contract's
   "Postgres counters for shared limits" applies to the authenticated
   write/invitation quotas where cross-instance accuracy matters.
3. The 3 owner-exports/hour quota is deferred to P9 together with the
   export feature itself (nothing to cap yet); recorded here so P9 picks
   it up.
4. Foreign-ID tests use cross-workspace IDs (W2's real prompt/revision in
   W1 paths); "coincidentally similar IDs" beyond that is not constructible
   with server-generated UUIDs — the shared-title twins cover the
   confusion case the plan aimed at.

## Record: 2026-09-21, post-P7 design alignment

User-directed pass (not a plan phase): reuse the existing portal design
language everywhere in the team UI instead of parallel/invented patterns.

Commit:

- `style(portal): align team workspace UI with portal design language`

What changed:

- Prompt detail now mirrors the public `/p/:id` viewer exactly: mono accent
  eyebrow ("Approved prompt"), `text-3xl` title, the real rendering pipeline
  (`markdownToHtml` + `highlightSource` in `Promise.all`, sanitize-before-
  highlight shared with the viewer) rendered through the shared `CodeBox`
  (traffic-light bar, "prompt.md" title, Rendered/Source toggle, Copy in the
  bar), sha-256 faint meta line, and `VersionHistory` (From/To selects,
  `.diff-view` lines) for prior published revisions.
- Proposal detail + editor diffs replaced bespoke `<pre>`s with the
  `code-box` structure and `.diff-view`/`.diff-line` classes from
  `version-history.tsx` (candidate.md / prompt.md titles).
- Shell and picker headers use the brand icon + PromptBranch wordmark
  treatment from the landing topbar; Library tags/collections use the
  portal pill tokens; section headings normalized to
  `tracking-tight text-ink`; accent buttons gained the portal's
  `active:translate-y-[1px]` micro-interaction.
- Tests updated for the (correct) new behavior: markdown + Shiki panes both
  carry the content text, Copy lives inside CodeBox, fixture seeds a prior
  revision so the history compare renders.

Gates after the pass: `pnpm typecheck`, `pnpm test` (323), `pnpm build`,
`git diff --check` — all green; verified in-browser on the drive workspace
(dark tokens, code-box chrome, diff colors consistent with the viewer).
`next-env.d.ts` churn from the dev server was reverted, not committed.

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
