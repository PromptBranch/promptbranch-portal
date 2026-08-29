"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import type { DocCategory, DocSearchResult } from "@/lib/docs";
import { DocsHeader } from "./docs-header";
import { DocsSidebar } from "./docs-sidebar";
import { DocsSearchModal } from "./docs-search";
import { MermaidRenderer } from "./mermaid-renderer";

interface DocsShellProps {
  children: ReactNode;
  navigation: DocCategory[];
  searchIndex: DocSearchResult[];
}

export function DocsShell({ children, navigation, searchIndex }: DocsShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  // The shell is rendered by the docs layout shared across every doc route,
  // so the active page can only be derived from the URL, never passed as a
  // prop. "/docs" itself renders the overview page (see app/docs/page.tsx).
  const pathname = usePathname();
  const slug = pathname.replace(/^\/docs\/?/, "").replace(/\/+$/, "");
  const currentSlug = slug === "" ? "getting-started/overview" : slug;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-app">
      <DocsHeader
        navigation={navigation}
        currentSlug={currentSlug}
        onOpenSearch={() => setSearchOpen(true)}
      />

      <div className="mx-auto flex w-full max-w-7xl flex-1 px-4 sm:px-6">
        {/* Desktop Left Sidebar */}
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 overflow-y-auto border-r border-line py-8 pr-4 md:block">
          <DocsSidebar navigation={navigation} currentSlug={currentSlug} />
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 min-w-0 py-8 px-0 md:px-8 xl:px-12">
          {children}
        </main>
      </div>

      <DocsSearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        searchIndex={searchIndex}
      />

      <MermaidRenderer />
    </div>
  );
}

