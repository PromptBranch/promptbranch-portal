import { ImageResponse } from "next/og";
import { getDb, getSnapshot } from "@/lib/db";

export const runtime = "nodejs";
// A deleted snapshot must stop serving its card immediately — never cache.
export const dynamic = "force-dynamic";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

/** The card is a fixed 1200x630 canvas and satori won't shrink overflowing
    text, so unbounded user strings would clip off the edge. */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Best-effort link-preview card; Task 17's static meta is the fallback when
    this route errors. Palette mirrors globals.css dark theme. */
export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getSnapshot(getDb(), id);
  let title = "PromptBranch snapshot";
  let tags: string[] = [];
  if (row && !row.deleted_at) {
    const payload = JSON.parse(row.payload) as { title?: string; tags?: string[] };
    title = truncate(payload.title ?? title, 80);
    tags = Array.isArray(payload.tags) ? payload.tags.slice(0, 4).map((tag) => truncate(tag, 24)) : [];
  }
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          backgroundColor: "#0b0e14",
          color: "#e6eaf2",
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, color: "#5d6779" }}>PromptBranch</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 600, lineHeight: 1.2 }}>{title}</div>
          <div style={{ display: "flex", gap: 12 }}>
            {tags.map((tag) => (
              <div
                key={tag}
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: "#3b82f6",
                  backgroundColor: "rgba(59, 130, 246, 0.14)",
                  borderRadius: 999,
                  padding: "6px 18px",
                }}
              >
                {tag}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
