import { snapshotSchema } from "@promptbranch/share";
import { highlightSource } from "@/lib/highlight";
import { markdownToHtml } from "@/lib/markdown-to-html";
import type { SnapshotRow } from "@/lib/db";
import { getEnv } from "@/lib/env";

export interface EmbedResponse {
  formatVersion: 1;
  id: string;
  url: string;
  title: string;
  description?: string;
  tags: string[];
  markdown: string;
  contentHtml: string;
  sourceHtml: string;
}

/** Keep this DTO narrower than the stored snapshot: history and portal-only
    metadata are unnecessary for an embed and should not cross this boundary. */
export async function buildEmbedResponse(row: SnapshotRow): Promise<EmbedResponse> {
  const snapshot = snapshotSchema.parse(JSON.parse(row.payload));
  const [contentHtml, sourceHtml] = await Promise.all([
    markdownToHtml(snapshot.content),
    highlightSource(snapshot.content),
  ]);
  const baseUrl = getEnv().PUBLIC_BASE_URL.replace(/\/+$/, "");

  return {
    formatVersion: 1,
    id: row.id,
    url: `${baseUrl}/p/${row.id}`,
    title: snapshot.title,
    ...(snapshot.description === undefined ? {} : { description: snapshot.description }),
    tags: snapshot.tags,
    markdown: snapshot.content,
    contentHtml,
    sourceHtml,
  };
}
