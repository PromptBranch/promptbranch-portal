# Gate ledger — Portal team workspaces (P0/P1)

Branch `feature/teams-portal`. Baseline `89665ff` (reviewed baseline, clean).

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
