import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(portalRoot, "../..");

describe("production container runtime contract", () => {
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
