"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { GithubLogo, MagnifyingGlass, List, X } from "@phosphor-icons/react";
import { ThemeToggle } from "@/components/theme-toggle";
import type { DocCategory } from "@/lib/docs";
import { DocsSidebar } from "./docs-sidebar";

interface DocsHeaderProps {
  navigation: DocCategory[];
  currentSlug: string;
  onOpenSearch: () => void;
}

export function DocsHeader({ navigation, currentSlug, onOpenSearch }: DocsHeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-line bg-app/85 px-4 backdrop-blur-md sm:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-dim hover:bg-hover hover:text-ink md:hidden"
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            {mobileMenuOpen ? <X size={20} /> : <List size={20} />}
          </button>

          <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-90">
            <Image src="/brand-icon.png" alt="" width={24} height={24} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-tight text-ink">PromptBranch</span>
          </Link>
          <span className="hidden text-ink-faint sm:inline">/</span>
          <Link href="/docs" className="hidden text-xs font-semibold uppercase tracking-wider text-accent sm:inline">
            Docs
          </Link>
        </div>

        {/* Search button trigger */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex h-9 items-center gap-2.5 rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink-dim shadow-xs transition-colors hover:border-line-strong hover:text-ink sm:w-64"
          >
            <MagnifyingGlass size={16} className="text-ink-faint" />
            <span className="hidden sm:inline">Search documentation...</span>
            <span className="sm:hidden">Search...</span>
            <kbd className="ml-auto hidden rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-faint sm:inline-block">
              ⌘K
            </kbd>
          </button>

          <div className="flex items-center gap-2">
            <a
              href="https://github.com/PromptBranch/promptbranch"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub Repository"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <GithubLogo size={20} />
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-16 z-40 bg-app/95 p-6 backdrop-blur-xl md:hidden overflow-y-auto">
          <DocsSidebar
            navigation={navigation}
            currentSlug={currentSlug}
            onLinkClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}
    </>
  );
}
