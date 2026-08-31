import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

/** A purpose-built social card keeps link previews legible without relying on
    a full application screenshot, which is too detailed at feed-card size. */
export default function HomeOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 68,
          backgroundColor: "#0b0e14",
          color: "#e6eaf2",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, fontWeight: 600, color: "#93a4bd" }}>
          PromptBranch
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 920 }}>
          <div style={{ display: "flex", fontSize: 74, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>
            Version control for AI prompts
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#aab6c8", lineHeight: 1.35 }}>
            Organize, evaluate, and share prompts with a local-first desktop app.
          </div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {['Version history', 'Prompt evaluation', 'Coding agents', 'Private by default'].map((feature) => (
            <div
              key={feature}
              style={{
                display: "flex",
                color: "#8db8ff",
                backgroundColor: "#13223a",
                borderRadius: 999,
                padding: "10px 17px",
                fontSize: 20,
              }}
            >
              {feature}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
