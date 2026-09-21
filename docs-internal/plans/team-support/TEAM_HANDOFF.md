# PromptBranch team support — simple handoff

This is the only file a new Portal implementation agent needs to start. The
detailed Portal plan contains the full requirements; this file tells the agent
where to begin and what receipt to return.

Give the agent this message:

```text
Work in /Users/shai/Desktop/Code/china/PromptBranch-Portal on branch feature/teams-portal.
Confirm with `pwd` and `git branch --show-current` before editing; do not create
or switch to a codex/* branch.
Read AGENTS.md and docs-internal/plans/team-support/2026-09-21-portal-implementation.md.
You own only the PromptBranch Portal repository. Start at the first unchecked P
task, preserve unrelated work, and run that task's tests before moving on. Do
not deploy, send real invitations, or change the PromptBranch repository.

Use the exact PB-TEAM-1 contract artifact when it is available. Until then, use
the contract fixtures/mock described in the plan and mark integration as pending.
When you stop, return the five-line handoff receipt below.
```

Return only this receipt to the coordinator:

```text
Repo / branch / commit: <path> / <branch> / <sha>
Completed: <P# and one-sentence result>
Contract: <version + SHA-256, or “unchanged”>
Checks: <commands and pass/fail>
Next: <next task, blocker, or exact dependency>
```

Portal handoff points:

1. P0/P1: local PostgreSQL, identity-provider fixture, contract acceptance and
   migrations.
2. P2/P3: authentication, sessions, workspaces, memberships, invitations and
   command authorization.
3. P4/P7: approved revisions, proposals, feed and browser experience.
4. P8/P10: privacy tests, recovery, real-client integration and pilot readiness.

Do not copy the conversation or tool logs into the next prompt. Pass only the
receipt and the contract version/hash. A mock-only result is marked integration
pending until the real PromptBranch client runs against the Portal API.
