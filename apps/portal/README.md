# PromptBranch Portal

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs&logoColor=white)](./package.json)
[![output](https://img.shields.io/badge/next%20config-output%3A%20standalone-informational)](./next.config.ts)
[![deploy](https://img.shields.io/badge/deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white)](#deploy)

Self-hosted sharing service for PromptBranch: anonymous publishers POST an
immutable prompt snapshot, receive an unguessable `/p/<id>` link and a
one-time delete token, and viewers get a sanitized SSR page with OG link
previews. Unlisted snapshot links only — no gallery, no discovery, no
indexing of shared snapshots (`robots.txt` disallows `/p/`; the landing
page and docs are indexable). The official hosted instance is
<https://promptbranch.app>.

> Part of [PromptBranch](../../README.md) · production deployment:
> [`deploy/portal`](../../deploy/portal/README.md)

Stack: Next.js 15 (App Router, `output: "standalone"`), better-sqlite3 (WAL)
in a single volume, in-memory per-IP rate limits on every route (publish,
reports, reads — exact numbers under Security notes below). Snapshots render
server-side through a sanitize-then-highlight pipeline (Shiki dual themes),
with a Rendered/Source code-box view. No third-party services — abuse
protection is rate limiting plus the server-side secret scan. The shared
contract (schemas, secret scanner, id/token helpers, HTTP client) lives in
`packages/share`.

## Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Origin every absolute URL derives from. `http://<ip>:3000` is valid — no domain required. Set to `https://<domain>` when Caddy terminates TLS. |
| `PORT` | `3000` | HTTP port inside the container/process. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Directory holding `portal.db` (SQLite, WAL). Back this up. |

## Development

```sh
pnpm install
pnpm --filter @promptbranch/portal dev       # http://localhost:3000
pnpm --filter @promptbranch/portal test      # vitest (API integration + viewer)
pnpm --filter @promptbranch/portal typecheck
```

API surface: `POST /api/snapshots` (publish; rate limit → Zod →
server-side secret scan → parentId existence check → `{ id, url, deleteToken }`),
`GET /api/snapshots/:id` (200/404/410),
`DELETE /api/snapshots/:id` (bearer delete token, soft delete),
`POST /api/reports` (takedown reports). Viewer at `/p/:id`.

`/` is the landing page (marketing copy, download links, theme toggle).
Light/dark theming: a pre-paint script in `layout.tsx` sets `data-theme` on
`<html>` from localStorage (`promptbranch:theme`, shared via
`src/lib/theme.ts`), falling back to the OS preference; the toggle persists
the choice. Middleware CSP adds `'unsafe-eval'` to `script-src` in
development only (react-refresh needs `eval`); production stays strict.

## Deploy

For the production VPS topology (rootful Docker, non-root portal container,
Nginx Proxy Manager, persistent volumes, UFW, SSH hardening, and Let's Encrypt),
use the reproducible deployment bundle in [`deploy/portal`](../../deploy/portal/README.md)
from the repository root. The Compose file below remains useful for a local or
single-container deployment with optional Caddy TLS.

```sh
docker compose up --build -d          # from apps/portal/
```

One container, one named volume (`portal-data`). Upgrades are boring on
purpose: `git pull && docker compose up --build -d`.

The standalone image copies the portal's `public/` assets because the landing
page uses `next/image`. The production deployment mounts only Next's image
cache as a `noexec,nosuid,nodev` tmpfs while keeping the rest of the image
read-only. The workspace keeps `sharp: false` in `allowBuilds`; if image
optimization later requires native `sharp`, revisit that policy explicitly.

### TLS (once a domain exists)

Point the domain at the server, then in `apps/portal/.env`:

```
DOMAIN=promptbranch.app
PUBLIC_BASE_URL=https://promptbranch.app
```

```sh
docker compose --profile tls up -d
```

Caddy obtains and renews certificates automatically.

### Backups

Snapshots are immutable, so a file-level copy with a WAL checkpoint is
consistent enough. Nightly host cron:

```sh
sqlite3 /var/lib/docker/volumes/portal_portal-data/_data/portal.db \
  ".backup '/backups/portal-$(date +%F).db'"
```

The production deployment uses differently named volumes; its offline backup
procedure lives in [`deploy/portal/README.md`](../../deploy/portal/README.md).

### Takedown procedure

Reports land in the `reports` table and in the container log
(`docker compose logs portal | grep '\[reports\]'`). To take a snapshot down:

```sh
sqlite3 <path-to-portal.db> \
  "UPDATE snapshots SET deleted_at = datetime('now') WHERE id = '<id>';"
```

Soft delete keeps lineage intact; the API returns 410 and the viewer renders
a "deleted" page afterwards.

## Security notes

- Delete tokens are 256-bit random, shown once, stored sha256-hashed;
  deletes compare hashes in constant time.
- Every publish is re-scanned server-side for secrets (OpenAI/Anthropic/
  Google/AWS/GCP/GitHub/Slack tokens, PEM blocks, high-entropy assignments,
  auth headers); high-severity findings reject with 422.
- Rate limits (in-memory token bucket per IP): publish 10/hour, reports
  5/hour, reads 300/minute. Restarting the container resets buckets.
- Viewer markdown is rendered through rehype-sanitize (GFM allowed, raw HTML
  stripped); strict nonce CSP, `X-Frame-Options: DENY`, no analytics.
- Publisher/reporter IPs are stored only as sha256 hashes with a
  daily-rotating salt.
- Client-IP trust model: rate limits and IP hashes key on the **last**
  `X-Forwarded-For` hop — the one a trusted proxy appends. The Caddy profile
  pins this (`header_up X-Forwarded-For {remote_host}`), so downstream sees
  exactly the real client IP. If you expose the portal directly without a
  proxy that appends/overwrites XFF, the header is fully client-supplied and
  rate limiting is best-effort only.
