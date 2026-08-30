import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDocPage, getNeighborPages } from "@/lib/docs";
import { DocsBreadcrumb } from "@/components/docs/docs-breadcrumb";
import { DocsToc } from "@/components/docs/docs-toc";
import { DocsPager } from "@/components/docs/docs-pager";
import { MarkdownHtml } from "@/components/markdown";

export const metadata: Metadata = {
  title: "Documentation Overview · PromptBranch",
  description: "Comprehensive documentation, user guides, API reference, and architecture for PromptBranch.",
};

export default async function DocsRootPage() {
  const page = await getDocPage("getting-started/overview");

  if (!page) {
    notFound();
  }

  const { prev, next } = getNeighborPages(page.slug);

  return (
    <div className="flex items-start justify-between gap-8">
      <article className="min-w-0 flex-1 max-w-3xl">
        <DocsBreadcrumb category={page.category} title={page.title} />

        <header className="mb-8 border-b border-line pb-6">
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            {page.title}
          </h1>
          {page.description && (
            <p className="mt-3 text-base text-ink-dim leading-relaxed">
              {page.description}
            </p>
          )}
        </header>

        {/* Rendered HTML */}
        <MarkdownHtml html={page.contentHtml} />

        {/* Pager */}
        <DocsPager prev={prev} next={next} />
      </article>

      {/* Table of contents */}
      <DocsToc toc={page.toc} />
    </div>
  );
}
