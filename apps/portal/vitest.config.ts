import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig keeps jsx: "preserve" for Next.js; tests need the automatic
  // runtime so JSX works without importing React in every file. Vite 8 uses
  // Oxc for this transform, so configure it directly instead of esbuild.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Two lanes: the HTTP suites spawn a real `next dev` server and starve
  // under 40-way fork parallelism (webpack compiles never finish inside the
  // readiness deadline), so they run with file parallelism off while
  // everything else fans out.
  test: {
    environment: "node",
    passWithNoTests: true,
    setupFiles: ["tests/setup.ts"],
    projects: [
      {
        // Real-server suites: spawned `next dev` starves under heavy fork
        // parallelism, so this lane runs files strictly one at a time.
        test: {
          name: "http-suites",
          include: ["tests/team-real-client.test.ts", "tests/team-http.test.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/team-real-client.test.ts", "tests/team-http.test.ts"],
        },
      },
    ],
  },
});
