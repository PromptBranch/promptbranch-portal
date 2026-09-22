/**
 * Regenerates the committed openapi.json and compatibility.json from the
 * built package. `pnpm --filter @promptbranch/team-contract openapi`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildOpenApiDocument, buildCompatibilityManifest } = await import(
  path.join(packageRoot, "dist", "index.js")
);

for (const [name, value] of [
  ["openapi.json", buildOpenApiDocument()],
  ["compatibility.json", buildCompatibilityManifest()],
]) {
  const target = path.join(packageRoot, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${name}`);
}
