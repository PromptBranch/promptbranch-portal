import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { snapshotSchema, type SnapshotPayload } from "@promptbranch/share";
import { GoneView } from "@/components/gone-view";
import { SnapshotView } from "@/components/snapshot-view";
import { getDb, getSnapshot } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { highlightSource } from "@/lib/highlight";
import { markdownToHtml } from "@/lib/markdown-to-html";

// Snapshots live in SQLite, not in the build: never statically cache.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function loadSnapshot(id: string): { found: boolean; deleted: boolean; snapshot: SnapshotPayload | null } {
  const row = getSnapshot(getDb(), id);
  if (!row) return { found: false, deleted: false, snapshot: null };
  if (row.deleted_at) return { found: true, deleted: true, snapshot: null };
  return { found: true, deleted: false, snapshot: snapshotSchema.parse(JSON.parse(row.payload)) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const { found, deleted, snapshot } = loadSnapshot(id);
  if (!found) return { title: "Not found" };
  if (deleted || !snapshot) return { title: "Snapshot deleted", robots: { index: false } };
  const description = snapshot.description ?? snapshot.content.slice(0, 160);
  return {
    title: snapshot.title,
    description,
    // Unlisted snapshots only: robots.txt disallows /p/, and each page
    // repeats noindex for crawlers that honor meta over robots.txt.
    robots: { index: false },
    openGraph: {
      title: snapshot.title,
      description,
      type: "article",
      siteName: "PromptBranch",
      url: `${getEnv().PUBLIC_BASE_URL}/p/${id}`,
      ...(snapshot.tags.length > 0 ? { tags: snapshot.tags } : {}),
    },
    twitter: { card: "summary", title: snapshot.title, description },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const { found, deleted, snapshot } = loadSnapshot(id);
  if (!found) notFound();
  if (deleted || !snapshot) return <GoneView />;
  const url = `${getEnv().PUBLIC_BASE_URL}/p/${id}`;
  const row = getSnapshot(getDb(), id)!;
  // All async rendering work happens here; SnapshotView stays synchronous.
  const [contentHtml, sourceHtml] = await Promise.all([
    markdownToHtml(snapshot.content),
    highlightSource(snapshot.content),
  ]);
  return (
    <SnapshotView
      id={id}
      url={url}
      snapshot={snapshot}
      publishedAt={row.published_at}
      contentHtml={contentHtml}
      sourceHtml={sourceHtml}
    />
  );
}
