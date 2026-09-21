import type { Metadata } from "next";
import type { ReactNode } from "react";

// Team surfaces are private per-user pages: never indexed and never listed
// in sitemap.xml or llms.txt (the landing page and docs stay indexable).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function TeamLayout({ children }: { children: ReactNode }) {
  return children;
}
