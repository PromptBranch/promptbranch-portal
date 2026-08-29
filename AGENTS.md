# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

PromptBranch Portal is the **self-hosted sharing backend for PromptBranch** (a local-first desktop app / CLI for AI prompts). Publishers POST an immutable prompt snapshot and receive an unguessable `/p/<id>` link plus a one-time delete token; viewers get a sanitized server-side rendered (SSR) page with OpenGraph previews and `promptbranch://import` deep links. Links are unlisted by design: no public directory, no indexing of shared snapshots (`robots.txt` disallows `/p/`; the landing page and docs are indexable), no third-party tracking. The official hosted instance is <https://promptbranch.app>.

This is a pnpm monorepo (pnpm 11.7.0, Node 26, TypeScript 5.9 strict):

```
apps/portal         @promptbranch/portal  — Next.js 15 App Router service (JSON API + SSR viewer)
packages/share      @promptbranch/share   — Sharing contract: Zod schemas, secret scanner,
                                            id/token generation, snapshot URL parsing, HTTP client.
                                            Zero Electron/DOM dependencies (shared with the desktop app).
deploy/portal       Production VPS deployment: Docker Compose + Nginx Proxy Manager,
                    host-hardening policies (fail2ban, UFW, sshd, unattended-upgrades).
```

## Commands

Run from the repository root:

```sh
pnpm install          # install workspace deps
pnpm dev              # portal dev server on http://localhost:3000
pnpm build            # recursive build (Next.js standalone build for portal)
pnpm start            # production `next start`
pnpm test             # vitest across all packages (share + portal)
pnpm typecheck        # strict tsc across all packages
```

Per-package: `pnpm --filter @promptbranch/portal <script>` or `--filter @promptbranch/share`. Both packages expose `test` and `typecheck`; the portal adds `dev`/`build`/`start`. There is no lint script and no CI pipeline in this repo — `pnpm typecheck && pnpm test` is the verification gate.

## Tech Stack

- **Next.js 15** (App Router, `output: "standalone"`), React 19, Node runtime route handlers (`export const runtime = "nodejs"`).
- **TypeScript 5.9**, strict plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules` (see `tsconfig.base.json`).
- **Tailwind CSS v4** via `@tailwindcss/postcss` (no tailwind.config file; theme tokens are CSS custom properties in `apps/portal/src/app/globals.css`).
- **better-sqlite3** (WAL mode, single file `portal.db`), **Zod 4** for all boundary validation, **nanoid** for snapshot ids.
- **unified/remark/rehype** pipeline with `rehype-sanitize` and **Shiki** (`@shikijs/rehype`) for dual-theme syntax highlighting.
- **Vitest 4** + Testing Library (React/jsdom) for tests.
- Phosphor icons (`@phosphor-icons/react`, SSR entry) for UI icons.

## Architecture

### API surface (all rate-limited)

| Route | Method | Behavior |
|---|---|---|
| `/api/snapshots` | POST | Publish. Order: content-length pre-check → rate limit → Zod parse → server-side secret scan (high findings → 422) → `parentId` existence check → atomic insert (snapshot + delete-token hash in one transaction) → `201 { id, url, deleteToken }`. Bodies over 256 KB → 413. |
| `/api/snapshots/:id` | GET | 200 snapshot JSON / 404 / 410 (soft-deleted). |
| `/api/snapshots/:id` | DELETE | Bearer delete token; token hash compared in constant time; idempotent soft delete (200 on already-deleted). |
| `/api/reports` | POST | Abuse report appended to `reports` table + `console.warn` log line. |

Pages: `/` landing (marketing, theme toggle, SEO metadata + JSON-LD), `/p/:id` viewer (`force-dynamic` — snapshots live in SQLite, never in the build), `/p/:id/opengraph-image` for OG images, plus machine files `robots.txt` (disallows `/p/` and `/api/` only), `sitemap.xml` (landing + docs), and `llms.txt` (plain-text index for AI agents).

### Data model (`apps/portal/src/lib/db.ts`)

SQLite tables created on open (WAL, `busy_timeout = 3000`): `snapshots` (immutable rows, `deleted_at` for soft delete), `delete_tokens` (sha256 hash only), `reports`. Columns intentionally stay Postgres-compatible. `getDb()` caches one handle per `DATA_DIR` and reopens when the dir changes (tests isolate via this).

### Rendering pipeline (security-critical order)

`markdownToHtml` (`apps/portal/src/lib/markdown-to-html.ts`): GFM parse → hast → **rehype-sanitize strips hostile markup first** → only then Shiki adds its own generated spans. On highlighter failure the same pipeline re-runs without Shiki (degrades to unhighlighted-but-sanitized). `page.tsx` awaits all async work (`markdownToHtml` + `highlightSource` in `Promise.all`) and passes HTML strings into `SnapshotView`, which stays synchronous by design.

### Key cross-cutting pieces

- `apps/portal/src/middleware.ts` — strict nonce CSP (`'strict-dynamic'`, no `unsafe-inline` for scripts; `style-src 'unsafe-inline'` is a deliberate documented trade-off) plus `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, permissions-policy. `'unsafe-eval'` is added to `script-src` **in development only** (react-refresh needs it). The nonce is propagated to the layout via the `x-nonce` request header.
- `apps/portal/src/lib/rate-limit.ts` — in-memory per-IP token buckets: publish 10/hour, reports 5/hour, reads 300/minute. Buckets reset on restart; single-instance deployment makes process-local state sufficient.
- `apps/portal/src/lib/ip.ts` — `clientIp` trusts the **last** `X-Forwarded-For` hop (the one a trusted proxy appends; Caddy pins it via `header_up X-Forwarded-For {remote_host}`). Without such a proxy, rate limiting is best-effort. `hashIp` stores only sha256(IP + daily-rotating salt) — raw IPs are never stored.
- `apps/portal/src/lib/env.ts` — `PUBLIC_BASE_URL` (default `http://localhost:3000`), `PORT` (3000), `DATA_DIR` (`./data`, `/data` in Docker). Zod-parsed on every call (not cached) so tests can mutate `process.env`.
- Theming — `data-theme` attribute on `<html>`, set pre-paint by an inline script built in `src/lib/theme.ts` (localStorage key `promptbranch:theme`, OS fallback), rendered under the CSP nonce. Dark is default; tokens mirror the desktop app's palette.

### `packages/share` module map

- `ids.ts` — 21-char nanoid snapshot ids (`/^[A-Za-z0-9_-]{21}$/`, ~128 bits), 256-bit base64url delete tokens, `hashToken` (sha256).
- `schema.ts` — `snapshotSchema` (the only data that crosses the trust boundary; notes/runs/ratings intentionally excluded), request/response schemas, `MAX_PAYLOAD_BYTES` (256 KB).
- `scanner.ts` — `scanForSecrets`: one rule set used by both the desktop client (warn layer) and the portal (enforcement layer). High severity (OpenAI/Anthropic/Google/AWS/GCP/GitHub/Slack tokens, PEM blocks, high-entropy assignments via Shannon entropy ≥ 4.0, auth headers) blocks; medium (internal URLs, emails) warns.
- `url.ts` — `parseSnapshotUrl` (accepts raw ids or `/p/<id>` / `/api/snapshots/<id>` URLs on any host), `resolvePortalBaseUrl`.
- `client.ts` — `publishSnapshot` / `fetchSnapshot` / `deleteSnapshot` returning `ShareResult<T>` discriminated unions; errors are a `kind` taxonomy (`network`, `not-found`, `gone`, `rejected`, `rate-limited`, …) — **callers switch on `kind`, never on message text**. `OFFICIAL_PORTAL_BASE_URL = "https://promptbranch.app"`.
- `payload.ts` — `buildSnapshotPayload` (assembles + validates the exact payload shape) and `uniqueImportTitle`.

The portal consumes the package via `workspace:*` and `transpilePackages` in `next.config.ts`.

## Code Style & Conventions

- **ESM everywhere** (`"type": "module"`). With `verbatimModuleSyntax`, type-only imports must use `import type`. Intra-package imports inside `packages/share` use explicit `.js` extensions (`./ids.js`).
- Path alias `@/*` → `apps/portal/src/*` (configured in portal tsconfig and its vitest config).
- Comments explain *why*, not what — many mark security-critical ordering and invariants. Keep that convention; do not delete invariant comments.
- Zod validates every boundary (request bodies, env, client responses).
- Functional, server-component-first React: only components needing interactivity are client components (`"use client"`: `copy-actions`, `theme-toggle`, `view-toggle`, `version-history`).
- Conventional Commits (`feat(portal): …`, `docs: …`).
- Docs and comments are in English.
- `pnpm-workspace.yaml` `allowBuilds`: `better-sqlite3` and `esbuild` may run install scripts; `sharp: false` is a deliberate policy (revisit explicitly if `next/image` optimization ever needs native sharp).

## Testing

- **Vitest** in both packages, run with `pnpm test` (or `-r` from root). Default environment is `node`.
- **Component tests** (`.tsx` files under `apps/portal/tests/`) opt into DOM per file with a `// @vitest-environment jsdom` pragma; `tests/setup.ts` registers RTL cleanup (vitest runs with `globals: false`).
- **Route-handler tests import the handlers directly** (e.g. `import { POST } from "@/app/api/snapshots/route"`) and invoke them with constructed `NextRequest`s — no server is booted.
- Test isolation patterns to follow:
  - `beforeEach`: `process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"))` — `getDb()` reopens per dir; `delete process.env.PUBLIC_BASE_URL` for defaults.
  - Unique IPs per request (an `ipCounter` helper) so shared module-level rate limiters don't bleed between tests.
  - Assert side effects on the database (row counts, stored hashes), not just status codes.
- `docker-runtime.test.ts` asserts deployment invariants as text (Dockerfile COPY lines, compose tmpfs mounts) — update it when changing deployment files intentionally.
- `packages/share` tests are plain unit tests; the HTTP client tests inject `fetchImpl`.

## Deployment

Two Compose files, both building from the **repo root** context (`dockerfile: apps/portal/Dockerfile`):

1. `apps/portal/docker-compose.yml` — single container + optional Caddy TLS terminator (`--profile tls`, set `DOMAIN` + `PUBLIC_BASE_URL` in `apps/portal/.env`). Caddy caps request bodies at 256 KB at the edge and pins `X-Forwarded-For` to the real client IP.
2. `deploy/portal/compose.yml` — hardened production: portal runs UID/GID `1000:1000`, read-only root fs, `cap_drop: ALL`, `no-new-privileges`, tmpfs for `/tmp` and the Next image cache, internal-only `app` network, healthchecks; Nginx Proxy Manager (pinned by digest) is the only public edge. `deploy/portal/scripts/bootstrap-host.sh` installs the host policy files under `deploy/portal/host/` (UFW, sshd hardening, fail2ban, unattended-upgrades). Full runbook: `deploy/portal/README.md`.

The Dockerfile is multi-stage (`node:26-alpine`; `better-sqlite3` compiles from source on musl — python3/make/g++ are installed in the deps stage), copies the standalone output expecting `server.js` at `apps/portal/server.js` (tracing root is the repo root, set in `next.config.ts`), and runs as non-root `node` with a `/data` volume.

Operations: upgrades are `git pull && docker compose up --build -d`. Back up SQLite with WAL checkpointing (`sqlite3 portal.db ".backup '<dest>'"`). Takedown = soft delete: `UPDATE snapshots SET deleted_at = datetime('now') WHERE id = '<id>';` (API then returns 410, viewer shows a gone page).

## Security Invariants — Do Not Break

- **Server-side secret scan is mandatory** on every publish; the client-side scan can be bypassed. High findings → 422 with the findings body; medium never blocks. Every publisher-supplied free-text field is scanned (title, description, content, tags, history change notes).
- **Sanitize before highlight** — the order in `markdown-to-html.ts` is load-bearing; never let user-supplied HTML reach Shiki or the page unsanitized.
- Delete tokens: 256-bit random, shown once, stored only as sha256, compared with `timingSafeEqual`. Snapshot + token inserts are wrapped in one transaction.
- Snapshots are immutable; deletion is soft only (`deleted_at`), preserving lineage. A deleted parent still validates as a `parentId`.
- No raw IPs at rest (daily-salted sha256 only), no cookies, no analytics, no external fonts/CDNs. Keep the viewer fully self-contained.
- `robots.ts` disallows `/p/` and `/api/` and points at `sitemap.xml`; the landing page and docs are indexable (SEO + JSON-LD, `sitemap.ts`, `llms.txt` for AI agents) but snapshot pages never appear there, and viewer pages repeat `noindex` — shared snapshots stay unlisted by design.
- Rate limits and the 256 KB payload cap apply to every route; keep both the pre-read (content-length) and post-read byte checks on publish.
