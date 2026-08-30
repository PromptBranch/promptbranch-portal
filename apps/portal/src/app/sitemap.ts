import type { MetadataRoute } from "next";
import { getAllDocPagesMeta } from "@/lib/docs";
import { getEnv } from "@/lib/env";

// Rendered per request: PUBLIC_BASE_URL is runtime configuration in Docker
// (set by compose, absent at build).
export const dynamic = "force-dynamic";

// Landing page and docs are indexable content. Snapshot pages are NEVER
// listed here — unlisted-by-design is a product guarantee.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = getEnv().PUBLIC_BASE_URL;
  return [
    // new URL().href pins the "/" suffix even when PUBLIC_BASE_URL has none.
    { url: new URL(base).href, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/docs`, changeFrequency: "weekly", priority: 0.9 },
    ...getAllDocPagesMeta().map((page) => ({
      url: `${base}/docs/${page.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
