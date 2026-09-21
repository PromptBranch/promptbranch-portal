# Start here — PromptBranch Portal team implementation

This package is for the coding agent responsible for the PromptBranch Portal
repository only.

## Repository

- Path: `/Users/shai/Desktop/Code/china/PromptBranch-Portal`
- Required branch: `feature/teams-portal`
- First tasks: **P0 and P1 only** — establish the local PostgreSQL, Keycloak and
  mail-capture environment, accept the shared contract, and build migrations and
  the transactional storage foundation.

Before editing, run:

```sh
cd /Users/shai/Desktop/Code/china/PromptBranch-Portal
pwd
git branch --show-current
git status --short
```

Stop if the path or branch differs. Do not create or switch branches. Preserve
unrelated changes.

## Read in this order

1. `AGENTS.md`
2. `2026-09-21-portal-implementation.md`
3. `2026-09-21-integration-contract.md`

The implementation plan is authoritative for task execution. The contract is
authoritative for cross-repository interfaces. No prior conversation is needed.

## Scope for this handoff

Complete P0 and P1 and their tests. If the PromptBranch agent has not yet supplied
the exact `@promptbranch/team-contract` artifact, use the packaged PB-TEAM-1
contract as the specification, continue with independent infrastructure/storage
work, and report G0 as integration pending. Do not invent alternative schemas.

Do not modify the PromptBranch repository, deploy production, send real emails,
or create real customer accounts.

Return exactly this receipt:

```text
Repo / branch / commit: /Users/shai/Desktop/Code/china/PromptBranch-Portal / feature/teams-portal / <sha>
Completed: P0/P1 — <one-sentence result>
Contract: <accepted version + SHA-256, or “G0 pending contract artifact”>
Checks: <commands and pass/fail>
Next: P2, or the exact blocker
```

When the coordinator supplies the D0 artifact, verify its SHA-256 and replace any
temporary mock-only contract consumption before claiming G0 complete.
