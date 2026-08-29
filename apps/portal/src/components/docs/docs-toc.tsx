"use client";

import { useEffect, useState } from "react";
import { ListBullets } from "@phosphor-icons/react";
import type { TocItem } from "@/lib/docs-markdown";

interface DocsTocProps {
  toc: TocItem[];
}

export function DocsToc({ toc }: DocsTocProps) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    if (toc.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );

    for (const item of toc) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [toc]);

  if (toc.length === 0) return null;

  return (
    <aside className="sticky top-24 hidden h-[calc(100vh-6rem)] w-60 shrink-0 overflow-y-auto pb-10 text-xs xl:block">
      <div className="flex items-center gap-2 font-semibold uppercase tracking-wider text-ink-faint mb-3">
        <ListBullets size={14} />
        <span>On this page</span>
      </div>
      <nav className="flex flex-col gap-1.5 border-l border-line pl-3">
        {toc.map((item) => {
          const isActive = activeId === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`transition-colors leading-relaxed ${
                item.level === 3 ? "pl-2.5" : ""
              } ${
                isActive
                  ? "font-semibold text-accent"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {item.text}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
