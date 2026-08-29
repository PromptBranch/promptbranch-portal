"use client";

import { useEffect } from "react";
import mermaid from "mermaid";

export function MermaidRenderer() {
  useEffect(() => {
    let active = true;

    const renderDiagrams = async () => {
      const nodes = document.querySelectorAll(".mermaid-diagram");
      if (nodes.length === 0) return;

      const isLight = document.documentElement.getAttribute("data-theme") === "light";

      mermaid.initialize({
        startOnLoad: false,
        theme: isLight ? "neutral" : "dark",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        themeVariables: isLight
          ? {
              primaryColor: "#f0efec",
              primaryTextColor: "#23272e",
              primaryBorderColor: "rgba(28, 25, 23, 0.25)",
              lineColor: "#2563eb",
              secondaryColor: "#ffffff",
              tertiaryColor: "#f7f7f5",
              fontSize: "13px",
            }
          : {
              primaryColor: "#151b26",
              primaryTextColor: "#e6eaf2",
              primaryBorderColor: "rgba(255, 255, 255, 0.15)",
              lineColor: "#3b82f6",
              secondaryColor: "#0f131c",
              tertiaryColor: "#0b0e14",
              fontSize: "13px",
            },
        securityLevel: "loose",
      });

      for (let i = 0; i < nodes.length; i++) {
        if (!active) break;
        const node = nodes[i] as HTMLElement;
        const encoded = node.getAttribute("data-code");
        if (!encoded) continue;
        const code = decodeURIComponent(encoded);
        const id = `mermaid-svg-${i}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          const { svg } = await mermaid.render(id, code);
          if (active) {
            node.innerHTML = svg;
          }
        } catch (err) {
          console.error("Failed to render Mermaid diagram:", err);
        }
      }
    };

    // Initial render
    renderDiagrams();

    // Re-render when theme toggles
    const observer = new MutationObserver(() => {
      renderDiagrams();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  return null;
}
