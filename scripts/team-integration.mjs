#!/usr/bin/env node
// Pilot integration receipt (plan P10): records the exact environment the
// portal side brings to the G-gates — commits, contract artifact hash, DB
// schema state, runtime versions, image digests — and states the gates
// whose evidence must come from the MAIN repo's artifacts. Those legs are
// PENDING by design: they are never claimed from portal-side tests alone.
//
//   node scripts/team-integration.mjs [--json]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: repoRoot }).toString().trim();
  } catch {
    return null;
  }
};

function packageVersion(name) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, name, "package.json"), "utf8"));
  return { version: manifest.version, next: manifest.dependencies?.next ?? manifest.devDependencies?.next ?? null };
}

function contractSha() {
  const file = join(repoRoot, "docs-internal", "contracts", "PB-TEAM-1.sha256");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim();
}

function pinnedImages() {
  const images = {};
  for (const compose of ["deploy/team/compose.dev.yml", "deploy/team/compose.prod.yml"]) {
    const full = join(repoRoot, compose);
    if (!existsSync(full)) continue;
    for (const match of readFileSync(full, "utf8").matchAll(/image:\s*([^\s]+)$/gm)) {
      images[match[1]] = compose;
    }
  }
  return Object.keys(images).sort();
}

const receipt = {
  generatedAt: new Date().toISOString(),
  portal: {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(["rev-parse", "HEAD"]),
    subject: git(["log", "-1", "--pretty=%s"]),
    node: process.version,
    packages: {
      portal: packageVersion("apps/portal"),
      teamServer: packageVersion("packages/team-server"),
      share: packageVersion("packages/share"),
    },
  },
  contract: {
    spec: "PB-TEAM-1 v1.0.0 (embedded in the implementation plan)",
    sha256File: contractSha(),
    ownedD0Artifact: "@promptbranch/team-contract@1.0.0 (vendored; see docs-internal/contracts/D0-provenance.md)",
    clientLibrary: "@promptbranch/team-client@0.1.0 (vendored; see docs-internal/contracts/D10-client-provenance.md)",
  },
  database: {
    migrations: readdirSync(join(repoRoot, "packages", "team-server", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort(),
    serverEpoch: "per-install (TEAM_SERVER_EPOCH); rotated by every recovery window",
  },
  pinnedImages: pinnedImages(),
  gates: {
    G0_contract_artifact: {
      status: "CLOSED",
      evidence:
        "@promptbranch/team-contract@1.0.0 vendored (source commit recorded in docs-internal/contracts/D0-provenance.md); wire schemas, limits vocabulary and error taxonomy adopted; lockstep suite apps/portal/tests/team-contract.test.ts",
    },
    G1_real_clients: {
      status: "MOSTLY CLOSED — web leg verified (P2 real Keycloak login, P7 browser drive); client-library leg verified (G2/G3 below)",
      pending: "desktop-app and MCP-server end-to-end legs are the main repo's integration work",
    },
    G2_full_roundtrip: {
      status: "CLOSED (client-library leg)",
      evidence:
        "the real @promptbranch/team-client drove a live portal over HTTP end-to-end: info, workspace, catalogue reads, agent proposal submit, distinct-reviewer approval, feed and bootstrap (apps/portal/tests/team-real-client.test.ts)",
    },
    G3_fault_scenarios: {
      status: "CLOSED (client-library leg)",
      evidence:
        "dropped command response replayed from the stored receipt with exactly one mutation; duplicate delivery idempotent; revoked agent credential fails closed",
    },
    G4_pilot_operated: {
      status: "READY-CANDIDATE",
      evidence: "deploy/team/compose.prod.yml + operator runbook; benchmark targets met in production mode (see ledger P10)",
    },
    G5_release: {
      status: "NOT-STARTED",
      reason: "two-week pilot with invited teams precedes wider availability",
    },
  },
  integrationLegsFromMainRepo: [
    "D0 contract artifact — DELIVERED (vendored; provenance recorded)",
    "D3 sync consumer fixtures — DELIVERED (conformance suite runs them)",
    "D10 built clients — client library delivered; desktop-app/MCP-server E2E remains main-repo integration work",
  ],
};

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`PromptBranch team integration receipt — ${receipt.generatedAt}`);
  console.log(`  portal:   ${receipt.portal.branch} @ ${receipt.portal.commit}`);
  console.log(`            ${receipt.portal.subject}`);
  console.log(`  contract: spec ${receipt.contract.spec}`);
  console.log(`            sha256 ${receipt.contract.sha256File ?? "(missing)"}`);
  console.log(`  schema:   migrations ${receipt.database.migrations[0]} … ${receipt.database.migrations.at(-1)}`);
  console.log(`  images:   ${receipt.pinnedImages.length} digest-pinned`);
  for (const [gate, state] of Object.entries(receipt.gates)) {
    console.log(`  ${gate}: ${state.status}${"pending" in state ? ` (pending: ${state.pending})` : ""}`);
  }
  console.log("  Legs owned by the main repo (artifact-based handoff, never assumed):");
  for (const leg of receipt.integrationLegsFromMainRepo) console.log(`    - ${leg}`);
}
