# docs-internal/contracts — accepted team contract records

`PB-TEAM-1.md` is the verbatim PB-TEAM-1 team integration contract text
(byte-identical to the section embedded between the `PB-TEAM-1-BEGIN/END`
markers in
`docs-internal/plans/team-support/2026-09-21-portal-implementation.md` and to
the standalone file in the 2026-09-21 handoff package).

- Accepted version: `1.0.0` (HTTP major `/api/team/v1`, protocol `1`)
- SHA-256 of `PB-TEAM-1.md`: `4264f958df5262486c2eff1c364b4c88056e7eea3b39aacf9266cdb797b0a5ce`
  (also recorded in `PB-TEAM-1.sha256`)

## Status: G0 pending contract artifact

This file is the **specification** the portal side implements against. It is
not the owned contract artifact: `@promptbranch/team-contract` (Zod schemas,
OpenAPI, fixtures, mock server) is owned by the main PromptBranch repository
and must be consumed at an exact packed/published version. Gate G0 completes
only when the real D0 artifact is verified against this SHA-256 and its
fixtures pass through imported runtime schemas on both sides
(`apps/portal/tests/team-contract.test.ts` upgrades itself automatically once
the package is installed).

Do not edit `PB-TEAM-1.md`; contract changes arrive as a coordinated
PB-TEAM-2 revision with its own hash. Do not create a private fork of the DTO
schemas here.
