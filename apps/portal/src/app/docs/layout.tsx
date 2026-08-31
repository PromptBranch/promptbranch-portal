import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getDocsNavigation, getDocsSearchIndex } from "@/lib/docs";
import { DocsShell } from "@/components/docs/docs-shell";

export const metadata: Metadata = {
  title: {
    default: "Documentation · PromptBranch",
    template: "%s · PromptBranch Docs",
  },
  description: "Customer and agent guides for the PromptBranch desktop app, CLI, MCP server, sharing, and sync.",
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
