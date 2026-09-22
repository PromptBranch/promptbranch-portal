# PromptBranch team development stack

Local dependency containers for the team workspaces feature: PostgreSQL 18,
the Keycloak reference OIDC provider and an SMTP capture service. Compose runs
**dependency containers only** — the portal itself runs on the host with
`pnpm dev` so the advertised loopback issuer is identical for the browser, the
portal Node process and native clients (contract C10).

Everything here is for local development and CI. Passwords in `.env.example`
are synthetic dev-only values; production uses a separate, non-test identity
and database configuration and is **not** part of this profile.

## Bring up / down

```sh
cp deploy/team/.env.example deploy/team/.env   # synthetic local credentials
pnpm team:dev:up                               # postgres + keycloak + mailpit (--wait on health)
pnpm team:dev:down                             # stop (keeps the named volume)
docker compose -p promptbranch-team-dev -f deploy/team/compose.dev.yml down -v   # also wipe data
```

## Reference addresses (contract C10)

| Service | Address | Notes |
|---|---|---|
| PostgreSQL | `127.0.0.1:54329` | databases `team` (app) and `keycloak` (IdP) |
| Keycloak | `http://127.0.0.1:48080` | issuer `http://127.0.0.1:48080/realms/promptbranch-dev`, console at `/admin/master` |
| SMTP capture | `127.0.0.1:48025` | Mailpit SMTP |
| Capture web UI | `http://127.0.0.1:48026` | view captured invitation email |
| Portal (host) | `http://127.0.0.1:4317` | `pnpm dev` with `PORT=4317` for the reference setup |

The container-to-container addresses differ, but the **advertised issuer must
remain exactly** `http://127.0.0.1:48080/realms/promptbranch-dev` — never
substitute a different host to make container DNS work.

## Roles and databases

`deploy/team/postgres-init/01-team-roles.sh` runs once on first initdb:

- `team_app` — DML-only runtime role used by the portal application.
- `team_migrate` — DDL role that owns `team` and runs the forward-only
  migration runner (`pnpm team:migrate`). Grants `team_app` its DML rights
  after each migration run.
- `team_admin` — dev-only superuser used by the test harness to create and
  drop isolated scratch databases. Never use in production.
- `keycloak` — isolated identity-provider database and role.

## Keycloak realm (`realm.dev.json`)

`pnpm team:dev:up` chains `scripts/team-keycloak-init.mjs`, which deletes and
rebuilds the realm through the Keycloak **admin API** on every run so the
stack always converges to the deterministic reference state. (`--import-realm`
is deliberately not used: Keycloak 26.7 realm import neither materializes the
standard client scopes — tokens would silently miss `auth_time`/`email_verified`
— nor accepts the desktop client's loopback wildcard-port redirect URI.)
`pnpm team:keycloak:init` can be re-run standalone; it is idempotent.

Reference configuration per contract C5:

- Realm `promptbranch-dev`, RS256, HTTPS not required (loopback dev only).
- Access tokens live 5 minutes; refresh rotation is forced
  (`revokeRefreshToken`, `refreshTokenMaxReuse: 0`); offline/SSO sessions cap
  at 30 days; authorization codes are single-use with a 5-minute transaction.
- Access tokens carry verified email, `auth_time` and `sid`; the
  `promptbranch-team-api` audience is added by a dedicated client scope.
- Clients (password/implicit grants **disabled** on all):
  - `promptbranch-web` — confidential BFF client, secret from
    `WEB_CLIENT_SECRET`, redirect `http://127.0.0.1:4317/*`.
  - `promptbranch-desktop` — public client, authorization code + S256 PKCE,
    loopback literal-IP callback on any port (`http://127.0.0.1:*`).
  - `promptbranch-cli` — public client, device authorization grant (+PKCE).
- Synthetic identities with **verified** local test addresses
  (`alice@promptbranch.test`, `bob@…`, `casey@…`, `dana@…`, `erin@…`),
  shared dev password `pb-team-dev-password`. These users exist only in this
  local realm.

## Images

Pinned by exact version **and** content digest; upgrade deliberately after
checking official release/security support, then update both fields:

- `postgres:18.4-alpine3.24@sha256:9a8afca5…de15`
- `quay.io/keycloak/keycloak:26.7.4@sha256:82a77884…b2c`
- `axllent/mailpit:v1.31.2@sha256:74d609a4…63d`

## Production operations (P9)

`compose.prod.yml` runs the team stack: pinned Postgres (database plane,
no external route), the migrations job (`docker compose -f
deploy/team/compose.prod.yml run --rm migrate` BEFORE deploying new
images), the team-enabled portal (edge plane; your reverse proxy
terminates TLS in front) and the job worker (edge plane for SMTP egress).
Keycloak is **not** shipped: production requires HTTPS and a separately
operated identity provider. All secrets come from `deploy/team/.env`,
generated on the host — never committed:

```sh
# 32-byte session key (base64) and the optional cursor HMAC key
openssl rand -base64 32   # TEAM_SESSION_ENCRYPTION_KEY
openssl rand -hex 32      # TEAM_CURSOR_SIGNING_KEY (optional)
uuidgen                   # TEAM_SERVER_ID, TEAM_SERVER_EPOCH
head -c 32 /dev/urandom > /secure/team-backup.key   # backup key file
```

Disabled (`TEAM_ENABLED=false`) or recovering (`TEAM_RECOVERY_MODE=1`)
the portal registers **no** usable team service — every team route 503s.

### Backups

Nightly (cron/systemd timer) and **before every migration**:

```sh
docker compose -f deploy/team/compose.prod.yml run --rm --rm \
  -v /secure/team-backup.key:/secure/team-backup.key:ro \
  -v /var/backups/team:/var/backups/team worker \
  node scripts/team-backup.mjs --out=/var/backups/team --sqlite=/data/portal.db
```

`pg_dump --format=custom` piped through `openssl enc -aes-256-cbc`
(plaintext never lands on disk), sha256 sidecar, 30-day retention, and a
consistent SQLite snapshot of the anonymous portal store via the
documented online-backup statement. Realm config and encryption keys are
backed up through your separate protected channel (they are NOT in the
database dump). Alerts: backup age > 26h.

### Restore and recovery

1. Bring the portal up with `TEAM_RECOVERY_MODE=1` (all team traffic 503s;
   readiness reports `recovery`).
2. `pnpm team:restore -- --dump=/var/backups/team/team-<ts>.dump.enc
   --key-file=/secure/team-backup.key --restored-from="team-<ts>"`
   — restores, then rotates every server epoch, revokes all app sessions
   and agent tokens, wipes materialized bootstraps, moves every feed
   retention floor to head (old cursors expire) and cancels queued jobs.
3. Verify the current roster, then close the window:
   `pnpm team:restore -- --finish-recovery=roster.json`
   (`{"emails": [...]}`). Memberships not confirmed by the roster are
   removed — a stale backup cannot revive removed users; sole-owner
   workspaces are protected and reported for manual resolution instead.
4. Clear `TEAM_RECOVERY_MODE`, restart the portal. Pre-restore tokens now
   authenticate 401; clients re-bootstrap at the rotated epoch.

Pilot targets: RPO ≤ 24h, RTO ≤ 4h — validate with a restore drill on a
scratch host using a deliberately stale backup.

### Metrics and alerts

The worker logs numeric-only gauges each tick (queue pending/running/
failed, oldest-due-job lag) and the portal exposes
`/api/team/v1/health/ready` (`ok` / `degraded` / `recovery` /
`disabled`) — never prompt bodies or internal addresses. Ship the logs to
your pipeline and alert on: backup age > 26h, failed migration,
persistent auth or database failure (health `degraded` > 5m), any job
`failed`, queue lag > 5m, disk > 80%. Latency/error-rate percentiles ride
on the reverse-proxy access logs.

### Exports

Workspace owners can request a portability export (`POST
/api/team/v1/workspaces/:w/export`, ≤ 3/hour/workspace): an NDJSON stream
with a manifest (schema version, record counts, feed high-water) where
every record carries the sha256 of its canonical JSON — verify with
`verifyExportRecord` from `@promptbranch/team-server`. Export is a
portability format, **not** a live restore/import API. Exports contain
domain content only (prompts, revisions, publications, tags, collections,
proposals, reviews, comments) — never sessions, token hashes, invitation
secrets, receipts or rate-bucket internals — and expire after 10 minutes.

## Staged rollout and rollback (P10 policy)

**Rollout**: deploy only to explicitly authorized staging first. The public
team feature stays disabled (`TEAM_ENABLED=false`) until acceptance; the
backend ships a compatible API before any client flag flips. Pilot with
2–3 invited teams and collect task success, conflict/retry rate, join
completion, time-to-find-approved-prompt and incidents — no content
analytics. Two weeks of use with no unresolved isolation or data-loss
defects precede wider availability.

**Rollback**: disable new team mutations (reverse proxy or `TEAM_ENABLED`),
preserve database/backups/queues, and serve an explicit unavailable state
— never reverse destructive migrations automatically; return to the last
compatible server image. Personal snapshot publishing continues
unaffected: the anonymous portal shares the process but none of the team
data stores.

**Readiness evidence** (production mode, synthetic 1,000 prompts /
10,000 revisions / 20 agent clients, local network):

| Target | Contract | Measured |
|---|---|---|
| Approved read p95 | ≤ 500 ms | 63 ms |
| Search p95 | ≤ 500 ms | 37 ms |
| Command acceptance p95 | ≤ 1 s | 8 ms |
| Full catalogue bootstrap | ≤ 60 s | 6.6 s (28.5 MB) |
| Second-client feed visibility | ≤ 30 s | 37 ms |

Reproduce with `pnpm team:benchmark` (loopback origins only, synthetic
content; exits non-zero on a target miss). `pnpm team:integration` prints
the current gate receipt — the real-client gates (G0/G2/G3) stay PENDING
until the main repository's contract artifact and built clients arrive.
