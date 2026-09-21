import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone output in a pnpm monorepo needs the tracing root at the repo
// root so server.js lands at apps/portal/server.js with a complete
// node_modules subset (the Dockerfile relies on that exact layout).
const nextConfig: NextConfig = {
  output: "standalone",
  // Dev-only: the reference team stack browses 127.0.0.1 while Next dev
  // treats localhost as the primary origin; without this, HMR (and with it
  // hydration) is blocked as a cross-origin dev resource.
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../.."),
  transpilePackages: ["@promptbranch/share", "@promptbranch/team-server"],
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
