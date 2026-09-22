# @promptbranch/team-contract

Runtime contract for the PromptBranch team protocol **PB-TEAM-1**
(HTTP major `/api/team/v1`, contract version `1.0.0`).

- `import { … } from "@promptbranch/team-contract"` — Zod schemas and the
  TypeScript types derived from them (`z.infer`; there are no parallel
  hand-written declarations), the route table, and the OpenAPI/compatibility
  document builders.
- `import { … } from "@promptbranch/team-contract/testing"` — canonical
  fixtures and the loopback mock server (Node-only, synthetic bearer tokens,
  never deployable auth).
- `openapi.json` / `compatibility.json` — generated artifacts; regenerate with
  `pnpm --filter @promptbranch/team-contract openapi` and never hand-edit.

Run the mock server locally:

```sh
pnpm --filter @promptbranch/team-contract mock --port 4318
```

It binds `127.0.0.1` only. Contract changes are coordinated revisions: update
schemas, fixtures, OpenAPI and the compatibility manifest together.
