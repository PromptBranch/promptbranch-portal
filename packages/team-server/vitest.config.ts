import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Real-PostgreSQL suites (scratch database create/migrate/drop) are slower
    // than unit tests; keep the default tight per test but generous per hook.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
