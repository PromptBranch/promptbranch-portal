"use client";

import { useEffect, useRef } from "react";
import { initializeEmbeds } from "@/embed/widget-runtime";

/** Use the shipped embed renderer so the teaser demonstrates the real widget. */
export function LiveEmbed({ snapshotUrl }: { snapshotUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node || typeof window.fetch !== "function") return;
    const syncTheme = () => {
      const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      node.dataset.promptbranchTheme = theme;
      node.dataset.pbThemeResolved = theme;
    };
    syncTheme();
    const origin = new URL(snapshotUrl).origin;
    const cleanup = initializeEmbeds({
      document, portalOrigin: origin, assetBaseUrl: origin, fetch: window.fetch.bind(window),
    });
    // Auto embeds follow the OS; this demo follows the landing page's toggle.
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { observer.disconnect(); cleanup(); };
  }, [snapshotUrl]);

  return (
    <div ref={host} data-promptbranch-embed={snapshotUrl} className="showcase-embed min-w-0">
      <noscript><a href={snapshotUrl}>View the example prompt</a></noscript>
    </div>
  );
}
