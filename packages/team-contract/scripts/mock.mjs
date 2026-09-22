/**
 * Mock launcher: `pnpm --filter @promptbranch/team-contract mock --port 4318`.
 * Serves the built dist; run `pnpm --filter @promptbranch/team-contract build`
 * first. Binds loopback only and uses synthetic bearer tokens — this is never
 * deployable auth (contract C9).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "dist", "testing", "index.js");
if (!fs.existsSync(entry)) {
  const build = spawnSync("pnpm", ["--filter", "@promptbranch/team-contract", "build"], {
    cwd: path.resolve(packageRoot, "../.."),
    stdio: "inherit",
  });
  if (build.status !== 0 || !fs.existsSync(entry)) {
    console.error("mock launcher: build failed; run `pnpm --filter @promptbranch/team-contract build`");
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 4318;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("mock launcher: --port must be an integer between 1 and 65535");
  process.exit(1);
}

const { createMockServer } = await import(entry);
const server = await createMockServer({ port });
console.log(`[promptbranch-team-contract] mock listening on ${server.origin}`);
console.log("synthetic tokens: pbtest_owner pbtest_maintainer pbtest_contributor pbtest_viewer pbtest_outsider pbtest_agent");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
