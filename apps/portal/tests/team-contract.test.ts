import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// P0 contract acceptance (gate G0).
//
// The owned contract artifact `@promptbranch/team-contract` (Zod schemas +
// fixtures) is produced by the main PromptBranch repository and pinned at an
// exact packed/published version (contract C9). Until that D0 artifact is
// installed, this suite verifies the accepted PB-TEAM-1 specification record
// instead and skips — loudly — the artifact checks, keeping G0 explicitly
// pending rather than silently green.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const contractPath = join(repoRoot, "docs-internal", "contracts", "PB-TEAM-1.md");
const contractShaPath = join(repoRoot, "docs-internal", "contracts", "PB-TEAM-1.sha256");

function contractPackageInstalled(): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("@promptbranch/team-contract/package.json");
    return true;
  } catch {
    return false;
  }
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("PB-TEAM-1 contract acceptance record", () => {
  it("records the accepted contract text and its SHA-256", () => {
    const text = readFileSync(contractPath, "utf8");
    const recorded = readFileSync(contractShaPath, "utf8").trim().split(/\s+/)[0];
    expect(recorded).toBe("4264f958df5262486c2eff1c364b4c88056e7eea3b39aacf9266cdb797b0a5ce");
    expect(sha256Of(contractPath)).toBe(recorded);
    // The acceptance record is the normative PB-TEAM-1 text, not a fork.
    expect(text).toContain("# Team integration contract PB-TEAM-1");
    expect(text).toContain("CommandEnvelope");
    expect(text).not.toContain("PB-TEAM-1-BEGIN");
  });
});

describe("G0: @promptbranch/team-contract artifact", () => {
  const installed = contractPackageInstalled();

  it.skipIf(!installed)("exposes the v1 runtime schemas", async () => {
    // Runs once the exact D0 artifact is installed (contract C9). Until then
    // G0 stays pending; this branch must not drift into portal-owned schemas.
    // The computed specifier keeps tsc from resolving the not-yet-published
    // package at typecheck time.
    const specifier = "@promptbranch/team-contract";
    const schemas = (await import(specifier)) as {
      commandEnvelopeSchema?: { parse: (v: unknown) => unknown };
      teamInfoSchema?: { parse: (v: unknown) => { protocol: number } };
    };
    expect(schemas.commandEnvelopeSchema).toBeTypeOf("object");
    expect(schemas.teamInfoSchema).toBeTypeOf("object");
  });

  it("is reported as pending while the artifact is absent", () => {
    if (installed) {
      expect(sha256Of(contractPath)).toBeTypeOf("string");
      return;
    }
    console.warn(
      "G0 pending: @promptbranch/team-contract artifact not installed — " +
        "contract acceptance is limited to the PB-TEAM-1 specification record.",
    );
    expect(readFileSync(contractPath, "utf8")).toContain("PB-TEAM-1");
  });
});
