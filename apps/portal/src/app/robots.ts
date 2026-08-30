import type { MetadataRoute } from "next";
import { getEnv } from "@/lib/env";

// Rendered per request: PUBLIC_BASE_URL is runtime configuration in Docker
// (set by compose, absent at build), so baking it at build time would emit
// a localhost sitemap URL in production.
export const dynamic = "force-dynamic";

// Shared snapshots stay unlisted-by-design: /p/<id> links and the JSON API
// are excluded from crawlers, while the landing page and docs are indexable.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: ["/p/", "/api/"] },
    sitemap: `${getEnv().PUBLIC_BASE_URL}/sitemap.xml`,
  };
}
