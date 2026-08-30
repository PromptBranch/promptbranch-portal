import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getDocsNavigation, getDocsSearchIndex } from "@/lib/docs";
import { DocsShell } from "@/components/docs/docs-shell";

export const metadata: Metadata = {
  title: {
    default: "Documentation · PromptBranch",
    template: "%s · PromptBranch Docs",
  },
  description: "Comprehensive documentation, user guides, API reference, and architecture for PromptBranch.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  const navigation = getDocsNavigation();
  const searchIndex = getDocsSearchIndex();

  return (
    <DocsShell navigation={navigation} searchIndex={searchIndex}>
      {children}
    </DocsShell>
  );
}
