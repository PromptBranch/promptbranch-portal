import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, RETRYABLE_ERROR_CODES, TEAM_LIMITS, TEAM_OPERATION_TYPES, CONTRACT_VERSION } from "@promptbranch/team-contract";
import { TEAM_ERROR_CODES } from "@promptbranch/team-server";
import { TEAM_LIMITS as PORTAL_LIMITS, TEAM_FEATURES, TEAM_CONTRACT_VERSION } from "@/lib/team/env";

// G0 contract acceptance. The owned `@promptbranch/team-contract` artifact
// (vendored at packages/team-contract; provenance with per-file hashes in
// docs-internal/contracts/D0-provenance.md) is now the single source of
// truth for wire schemas. This suite pins the lockstep invariants: the
// accepted PB-TEAM-1 specification record, artifact compatibility metadata,
// the error-code taxonomy (including retryable flags) and the limits
// vocabulary shared by the portal runtime.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const contractPath = join(repoRoot, "docs-internal", "contracts", "PB-TEAM-1.md");
const contractShaPath = join(repoRoot, "docs-internal", "contracts", "PB-TEAM-1.sha256");

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("PB-TEAM-1 contract acceptance record", () => {
  it("records the accepted contract text and its SHA-256", () => {
    const text = readFileSync(contractPath, "utf8");
    const recorded = readFileSync(contractShaPath, "utf8").trim().split(/\s+/)[0];
    expect(recorded).toBe("4264f958df5262486c2eff1c364b4c88056e7eea3b39aacf9266cdb797b0a5ce");
    expect(sha256Of(contractPath)).toBe(recorded);
    expect(text).toContain("# Team integration contract PB-TEAM-1");
    expect(text).toContain("CommandEnvelope");
    expect(text).not.toContain("PB-TEAM-1-BEGIN");
  });
});

describe("G0: @promptbranch/team-contract artifact lockstep", () => {
  it("declares compatibility for the protocol and features the portal serves", () => {
    const compatibility = JSON.parse(
      readFileSync(join(repoRoot, "packages", "team-contract", "compatibility.json"), "utf8"),
    ) as { protocol: number; contractVersion: string; features: string[] };
    expect(compatibility.protocol).toBe(1);
    expect(compatibility.contractVersion).toBe("1.0.0");
    expect(CONTRACT_VERSION).toBe("1.0.0");
    expect(TEAM_CONTRACT_VERSION).toBe(compatibility.contractVersion);
    expect([...TEAM_FEATURES].sort()).toEqual([...compatibility.features].sort());
  });

  it("shares the portal's error-code taxonomy, including retryable flags", () => {
    expect([...TEAM_ERROR_CODES].sort()).toEqual([...ERROR_CODES].sort());
    // The artifact's retryable set must be exactly what the portal marks
    // retryable on the wire (RATE_LIMITED / UNAVAILABLE; QUOTA_EXCEEDED not).
    expect([...RETRYABLE_ERROR_CODES].sort()).toEqual(["RATE_LIMITED", "UNAVAILABLE"]);
  });

  it("owns the limits vocabulary the portal advertises", () => {
    // TEAM_LIMITS is imported from the artifact in lib/team/env; deep-equal
    // guards against a future accidental re-literal.
    expect(PORTAL_LIMITS).toEqual(TEAM_LIMITS);
    expect(TEAM_LIMITS.maxRequestBytes).toBe(262_144);
    expect(TEAM_LIMITS.maxActiveTokensPerMember).toBe(20);
  });

  it("enumerates exactly the 23 C4 operations the dispatch implements", () => {
    expect(TEAM_OPERATION_TYPES).toHaveLength(23);
    for (const type of TEAM_OPERATION_TYPES) {
      expect(typeof type).toBe("string");
    }
  });
});
