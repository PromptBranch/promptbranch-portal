import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(portalRoot, "../..");

describe("production container runtime contract", () => {
  it("uses a Node 26 image with the CVE-2026-111497 fix in both stages", () => {
    const dockerfile = readFileSync(resolve(portalRoot, "Dockerfile"), "utf8");
    const stages = [...dockerfile.matchAll(/^FROM node:(26\.(\d+)\.(\d+)-alpine3\.24) AS (deps|runner)$/gm)];

    expect(stages.map((stage) => stage[4])).toEqual(["deps", "runner"]);
    for (const stage of stages) {
      const minor = Number(stage[2]);
      const patch = Number(stage[3]);
      expect(minor > 12 || (minor === 12 && patch >= 1)).toBe(true);
    }
  });

  it("ships public assets and gives next/image a writable cache", () => {
    const dockerfile = readFileSync(resolve(portalRoot, "Dockerfile"), "utf8");
    const compose = readFileSync(resolve(repositoryRoot, "deploy/portal/compose.yml"), "utf8");

    expect(dockerfile).toContain("COPY --from=build /repo/apps/portal/public ./apps/portal/public");
    expect(compose).toContain("- /app/apps/portal/.next/cache:rw,noexec,nosuid,nodev");
  });

  it("builds embed assets before running Next on webpack", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(portalRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.dev).toBe("pnpm embed:build && next dev --webpack");
    expect(packageJson.scripts.build).toBe("pnpm embed:build && next build --webpack");
  });
});
