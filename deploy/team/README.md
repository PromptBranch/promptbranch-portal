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
