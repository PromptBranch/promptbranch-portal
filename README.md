<div align="center">

# PromptBranch Portal

**Self-hosted sharing service, snapshot viewer, and API for PromptBranch**

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs&logoColor=white)](./apps/portal/package.json)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](#production-deployment)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](#configuration)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](pnpm-workspace.yaml)

</div>

---

PromptBranch Portal is the self-hosted sharing backend for [PromptBranch](https://github.com/PromptBranch/promptbranch). It allows PromptBranch Desktop and CLI users to publish immutable prompt snapshots behind unguessable URLs (`/p/<id>`), offering a clean, sanitized server-side rendered (SSR) web viewer with OpenGraph previews and `promptbranch://import` deep links.

Links are **unlisted by design** — there is no public directory, no indexing of shared snapshots (`robots.txt` disallows `/p/`; the landing page and docs are indexable), and zero third-party tracking.

## Repository Layout

```
apps/portal         Next.js 15 App Router web service (JSON API + SSR snapshot viewer)
packages/share      Sharing contract: snapshot Zod schemas, secret scanner, HTTP client
deploy/portal       Production VPS deployment bundle: Docker Compose, Nginx Proxy Manager,
                    host-hardening policies (fail2ban, UFW, SSH, auto-upgrades)
```

## Quick Start (Local Development)

```sh
pnpm install
pnpm dev              # starts the portal on http://localhost:3000
pnpm test             # runs all test suites (share contract + portal API & viewer)
pnpm typecheck        # strict TypeScript checks across packages
pnpm build            # production Next.js build
```

## Production Deployment

### 1. Single Container / Local Docker

From `apps/portal/`:

```sh
docker compose up --build -d
```

With automatic Caddy TLS (once your domain points to the server):

```sh
# In apps/portal/.env set DOMAIN=promptbranch.yourdomain.com and PUBLIC_BASE_URL=https://promptbranch.yourdomain.com
docker compose --profile tls up -d
```

### 2. Hardened Production VPS Deployment

For a full production VPS setup behind Nginx Proxy Manager with automated host-hardening (SSH, fail2ban, UFW firewall):

See the complete runbook in [`deploy/portal/README.md`](./deploy/portal/README.md).

```sh
# 1. Bootstrap host security
sudo bash deploy/portal/scripts/bootstrap-host.sh

# 2. Configure environment
cp deploy/portal/.env.example deploy/portal/.env
# Edit PUBLIC_BASE_URL, DATA_DIR, and PORT

# 3. Launch stack
docker compose -f deploy/portal/compose.yml up -d
```

## Environment Configuration

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public origin used for canonical URLs and deep links (e.g. `https://promptbranch.app`). |
| `PORT` | `3000` | HTTP port inside the container. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Persistent directory storing `portal.db` (SQLite in WAL mode). |

## Security & Privacy Architecture

- **Server-Side Secret Scanning:** Every snapshot publish is scanned on the server before storage. High-severity secrets (API keys, private keys, auth tokens) are rejected immediately with HTTP 422.
- **Revocable Delete Tokens:** Publishers receive a 256-bit random delete token. The token is never stored in plaintext (stored as SHA-256 hash) and validated in constant time.
- **Strict Rate Limiting:** Built-in in-memory token buckets per IP:
  - Publish: `10 / hour`
  - Reports: `5 / hour`
  - Reads: `300 / minute`
- **Sanitized SSR Rendering:** Markdown is parsed and sanitized with `rehype-sanitize` before syntax highlighting with Shiki.
- **Zero Third-Party Trackers:** No analytics, no cookies, no external fonts or CDN dependencies.

## Database Backups & Administration

### Backups

Snapshots are immutable. A safe online backup can be run against the SQLite database with WAL checkpointing:

```sh
sqlite3 /data/portal.db ".backup '/backups/portal-$(date +%F).db'"
```

### Takedown Procedure

Abuse reports are logged to the `reports` table. To take down a reported snapshot:

```sh
sqlite3 /data/portal.db "UPDATE snapshots SET deleted_at = datetime('now') WHERE id = '<snapshot-id>';"
```

Soft deletion preserves lineage while causing the API to return HTTP 410 Gone and the web viewer to display a takedown notice.
