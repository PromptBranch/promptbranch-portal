import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { getEnv } from "@/lib/env";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  // Absolute OG/Twitter image URLs require a base; falls back to localhost in dev.
  metadataBase: new URL(getEnv().PUBLIC_BASE_URL),
  title: { default: "PromptBranch", template: "%s · PromptBranch" },
  description: "Shared PromptBranch prompt snapshots.",
};

// Pre-paint theme bootstrap, built by lib/theme.ts so the inlined key can
// never drift from the toggle. Executed under the per-request CSP nonce.
const THEME_INIT = themeInitScript();

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers() makes routes dynamic; the nonce comes from middleware.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning: the pre-paint script mutates data-theme (and
    // the browser normalizes the script nonce) before hydration — expected.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="describedby" href="/llms.txt" type="text/plain" />
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
