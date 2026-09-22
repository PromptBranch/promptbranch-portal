# Team workspaces

PromptBranch keeps your personal library local-first, but when several
people maintain prompts together, a **team workspace** adds shared review
on top of your own library. Workspaces are opt-in: nothing about your
personal prompts changes unless you create or join one.

Team workspaces are in pilot. Everything below describes validated
behavior of the current release.

## What a workspace is

A workspace holds an **approved library**: prompts, their published
revisions, tags and collections. Nothing enters the approved library
directly — members propose changes, a different maintainer reviews them,
and only approval publishes. This is the same review discipline the
sharing portal applies to snapshots, extended to a group.

Members have one of four roles:

| Role | Can do |
|---|---|
| Owner | Everything, plus members, invitations, audit, workspace deletion and export |
| Maintainer | Seed and approve prompts, mint agent tokens |
| Contributor | Propose changes and comment on proposals |
| Viewer | Read the approved library only |

Reviews require a **different person** than the proposal's author, and an
approval always binds the exact revision that was reviewed — a proposal
edited mid-review must be rebased and reviewed again.

## Browser, member and admin behavior

- **Signing in**: workspaces use your team's identity provider (the
  administrator configures it). Sessions are revocable per device from
  your account page, and signing out everywhere is one click.
- **Joining**: owners invite by email. The emailed link shows the
  workspace name and role before you accept. Invitations expire and can
  be revoked; a revoked or consumed link never grants access.
- **Day to day**: browse the library with search, tags and collections;
  open a prompt to read the approved content, compare any two published
  revisions, or follow the `promptbranch://` deep link to import a local
  copy. Proposals show a live diff against their base revision.
- **Removing a member** takes effect immediately: their credentials,
  queued commands and agent tokens stop working, and the membership
  generation advances so no stale client can resume.

## Agents (CLI/MCP)

Members can mint scoped **agent tokens** (`pbt_…`) so coding agents can
read the approved library and submit proposals. Tokens are shown exactly
once, can carry only `catalog:read`, `proposal:write`, `note:write` and
`run:write` scopes, never exceed their owner's role, and are revoked the
moment the owner's membership changes. Human-only actions (reviewing,
membership, export) can never be performed by an agent token.

## Privacy model

- Workspace content lives on the team's server, **not** in anyone's
  personal local library. Your local copies are yours; the workspace
  never claims ownership of them.
- Shared personal snapshot links (`/p/…`) remain unlisted and unrelated
  to workspaces. Team pages are never indexed and never appear in the
  site's sitemap.
- Proposed (unapproved) content is visible only to contributors and
  above — viewers and outsiders never see candidate text.
- The audit log records actor, action and resource only — never prompt
  content or credentials.
- Suspected secrets are blocked server-side on every write, the same
  scanner the sharing portal enforces.

## Offline copies and limits

Importing a prompt (deep link, or a client sync) gives you a **local
copy** at that moment. That copy is not remotely erasable — if content is
later rolled back or removed in the workspace, your offline copy stays.
Owners can export the workspace (NDJSON with per-record checksums) as a
portability snapshot; an export is a snapshot, not a live backup or
import API, and expires shortly after creation.

## Deleting things

- Removing a member keeps the workspace and history intact.
- Deleting an account requires transferring sole ownership first; the
  person's name and email are then anonymized ("Former member") while
  audit history keeps its actor references.
- Deleting a workspace disables it immediately and purges its content
  after 30 days; metadata-only audit entries are kept for 90 days.
