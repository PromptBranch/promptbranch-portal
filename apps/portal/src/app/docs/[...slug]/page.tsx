import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllDocPagesMeta, getDocPage, getNeighborPages } from "@/lib/docs";
import { DocsBreadcrumb } from "@/components/docs/docs-breadcrumb";
import { DocsToc } from "@/components/docs/docs-toc";
import { DocsPager } from "@/components/docs/docs-pager";
import { MarkdownHtml } from "@/components/markdown";

interface DocPageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateStaticParams() {
  const pages = getAllDocPagesMeta();
  return pages.map((p) => ({
    slug: p.slugArray,
  }));
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await getDocPage(slug);
  if (!page) return { title: "Not Found" };

  return {
    title: page.title,
    description: page.description,
    // Resolved against metadataBase (runtime PUBLIC_BASE_URL) at render.
    alternates: { canonical: `/docs/${page.slug}` },
    openGraph: {
      title: `${page.title} · PromptBranch Docs`,
      description: page.description,
    },
  };
}

export default async function DynamicDocPage({ params }: DocPageProps) {
  const { slug } = await params;
  const page = await getDocPage(slug);

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
