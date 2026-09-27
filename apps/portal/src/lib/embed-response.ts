import { createHash } from "node:crypto";
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

interface EmbedRendering {
  contentHtml: string;
  sourceHtml: string;
  tokenStyles: Map<string, string>;
}

const SHIKI_PROPERTY = /^--shiki-(?:light|dark)(?:-bg|-font-weight|-font-style|-text-decoration)?$/;

function validShikiValue(property: string, value: string): boolean {
  if (property.endsWith("-font-weight")) return /^(?:normal|bold|[1-9]00)$/.test(value);
  if (property.endsWith("-font-style")) return /^(?:normal|italic|oblique)$/.test(value);
  if (property.endsWith("-text-decoration")) {
    return /^(?:none|underline|overline|line-through)$/.test(value);
  }
  return /^(?:#[\da-f]{3,8}|transparent)$/i.test(value);
}

function parseShikiStyle(style: string): string[] {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) return false;
      const property = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      return SHIKI_PROPERTY.test(property) && validShikiValue(property, value);
    })
    .sort();
}

function classedHighlight(html: string, tokenStyles: Map<string, string>): string {
  return html.replace(/<([a-z][a-z\d-]*)([^<>]*)>/gi, (opening, tag: string, attributes: string) => {
    const style = /\sstyle="([^"]*)"/i.exec(attributes);
    if (!style) return opening;

    const declarations = parseShikiStyle(style[1] ?? "");
    const remainder = attributes.replace(style[0], "");
    if (declarations.length === 0) return `<${tag}${remainder}>`;

    const signature = declarations.join(";");
    const tokenClass = `pb-shiki-${createHash("sha256").update(signature).digest("hex").slice(0, 12)}`;
    tokenStyles.set(tokenClass, signature);
    const classAttribute = /\sclass="([^"]*)"/i.exec(remainder);
    const nextAttributes = classAttribute
      ? remainder.replace(classAttribute[0], ` class="${classAttribute[1]} ${tokenClass}"`)
      : `${remainder} class="${tokenClass}"`;
    return `<${tag}${nextAttributes}>`;
  });
}

async function buildEmbedRendering(content: string): Promise<EmbedRendering> {
  const [rendered, source] = await Promise.all([markdownToHtml(content), highlightSource(content)]);
  const tokenStyles = new Map<string, string>();
  return {
    contentHtml: classedHighlight(rendered, tokenStyles),
    sourceHtml: classedHighlight(source, tokenStyles),
    tokenStyles,
  };
}

/** Keep this DTO narrower than the stored snapshot: history and portal-only
    metadata are unnecessary for an embed and should not cross this boundary. */
export async function buildEmbedResponse(row: SnapshotRow): Promise<EmbedResponse> {
  const snapshot = snapshotSchema.parse(JSON.parse(row.payload));
  const { contentHtml, sourceHtml } = await buildEmbedRendering(snapshot.content);
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

/** Move Shiki's generated token variables into a same-origin stylesheet so
    embeds work under host CSPs that allow the portal but block style attrs. */
export async function buildEmbedTokenStyles(row: SnapshotRow): Promise<string> {
  const snapshot = snapshotSchema.parse(JSON.parse(row.payload));
  const { tokenStyles } = await buildEmbedRendering(snapshot.content);
  return [...tokenStyles]
    .map(([tokenClass, declarations]) => `.${tokenClass}{${declarations}}`)
    .join("\n");
}
