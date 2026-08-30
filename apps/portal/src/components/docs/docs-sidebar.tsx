"use client";

import Link from "next/link";
import {
  RocketLaunch,
  Sliders,
  Plug,
  ArrowsClockwise,
  ShareNetwork,
  Cpu,
} from "@phosphor-icons/react";
import type { DocCategory } from "@/lib/docs";

interface DocsSidebarProps {
  navigation: DocCategory[];
  currentSlug: string;
  onLinkClick?: () => void;
}

const CATEGORY_ICONS: Record<string, typeof RocketLaunch> = {
  "getting-started": RocketLaunch,
  features: Sliders,
  integrations: Plug,
  sync: ArrowsClockwise,
  sharing: ShareNetwork,
  reference: Cpu,
};

export function DocsSidebar({ navigation, currentSlug, onLinkClick }: DocsSidebarProps) {
  return (
    <nav className="flex flex-col gap-6 py-2 text-sm">
      {navigation.map((category) => {
        const Icon = CATEGORY_ICONS[category.id] ?? Sliders;
        return (
          <div key={category.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              <Icon size={14} className="text-ink-faint" />
              <span>{category.title}</span>
            </div>

            <div className="flex flex-col gap-0.5 border-l border-line ml-4 pl-2">
              {category.items.map((item) => {
                const isActive = item.slug === currentSlug;
                return (
                  <Link
                    key={item.slug}
                    href={`/docs/${item.slug}`}
                    onClick={onLinkClick}
                    className={`group flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                      isActive
                        ? "bg-accent-soft font-semibold text-accent"
                        : "text-ink-dim hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <span>{item.title}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
