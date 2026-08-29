# Dependency PR Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish mandatory repository validation, merge the independently verified low-risk dependency updates, and defer framework/compiler migrations that need dedicated upgrade work.

**Architecture:** Add one least-privilege GitHub Actions workflow that reproduces the repository's local install, typecheck, test, and production-build gate on pull requests and protected branches. Evaluate each Dependabot PR from an isolated worktree against its exact head revision, merge serially so every subsequent PR is refreshed against the new base, and close major migrations with evidence-backed comments rather than mixing them into routine maintenance.

**Tech Stack:** GitHub Actions, Node.js 26, pnpm 11.7.0, Next.js 15, TypeScript, Vitest, Docker.

**Spec:** User-approved execution of the dependency-PR recommendations from the 2026-08-29 GitHub status review.

## Global Constraints

- Preserve all PromptBranch Portal security invariants in `AGENTS.md`.
- Use Node.js 26 and pnpm 11.7.0.
- Require a frozen `pnpm-lock.yaml` install.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before merge.
- Keep Next.js 16 and TypeScript 7 as separate, deferred migrations.
- Do not merge a PR with failed or missing validation after CI is established.

---

### Task 1: Continuous integration gate

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/dependabot.yml`

**Interfaces:**
- Consumes: root `packageManager`, workspace scripts, and `pnpm-lock.yaml`.
- Produces: the `CI / verify` GitHub check for pull requests and pushes to `main` or `dev`.

- [ ] **Step 1: Add the workflow**

Create a least-privilege workflow with concurrency cancellation, Node.js 26, pnpm 11.7.0, frozen installation, typecheck, tests, and production build.

- [ ] **Step 2: Add Dependabot coverage for actions**

Add a weekly `github-actions` ecosystem entry rooted at `/` so workflow actions receive their own reviewable updates.

- [ ] **Step 3: Validate locally**

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`

Expected: exit 0; 6 share test files and 23 portal test files pass; the Next.js production build completes.

- [ ] **Step 4: Commit, push, and open the PR**

Commit as `chore(ci)`, push `codex/ci-dependency-gates`, and open a PR against `main`.

- [ ] **Step 5: Verify the hosted check and merge**

Wait for `CI / verify`; merge only when it succeeds.

### Task 2: Routine dependency PRs

**Files:**
- PR #1: `apps/portal/package.json`, `packages/share/package.json`, `pnpm-lock.yaml`
- PR #2: `packages/share/package.json`, `pnpm-lock.yaml`
- PR #4: `apps/portal/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: CI established by Task 1 and refreshed Dependabot heads.
- Produces: serially merged, independently verified dependency updates.

- [ ] **Step 1: Refresh and verify PR #1**

Test its exact head in an isolated worktree with the full install/typecheck/test/build gate. Merge only after both local and hosted checks succeed.

- [ ] **Step 2: Refresh and verify PR #2**

Repeat the full gate after #1 lands. Confirm the Nano ID tests still enforce 21-character snapshot IDs and token behavior before merge.

- [ ] **Step 3: Refresh and verify PR #4**

Repeat the full gate after #2 lands. Confirm Vitest 4 runs against Vite 8 and the production Next.js build still completes before merge.

### Task 3: Deferred migration PRs

**Files:**
- GitHub PR #3 conversation/state
- GitHub PR #5 conversation/state

**Interfaces:**
- Consumes: official advisory and upgrade documentation.
- Produces: closed PRs with durable rationale for later migration work.

- [ ] **Step 1: Defer Next.js 16**

Comment that Next.js 15.5.24 is already patched for the cited advisories and that the future migration must cover `middleware.ts` to `proxy.ts`, Turbopack-default behavior, standalone Docker output, and runtime smoke tests. Close PR #3.

- [ ] **Step 2: Defer TypeScript 7**

Comment that TypeScript 7 is the native compiler transition without the traditional programmatic API, and that the project should move through TypeScript 6 before reconsidering 7 with its framework/tooling compatibility verified. Close PR #5.

### Task 4: Final verification

**Files:**
- GitHub repository and PR metadata only

**Interfaces:**
- Consumes: all prior task results.
- Produces: final status evidence.

- [ ] **Step 1: Inspect repository state**

Confirm `main` contains the CI workflow and the intended dependency versions.

- [ ] **Step 2: Inspect PR state and checks**

Confirm #1, #2, and #4 are merged; #3 and #5 are closed and unmerged; and the current `main` CI run succeeds.

- [ ] **Step 3: Report exact evidence**

Report commit/PR links, check outcomes, test counts, build outcome, and any remaining limitations.
