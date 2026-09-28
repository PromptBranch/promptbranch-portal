"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Copy } from "@phosphor-icons/react/dist/ssr";
import { buildEmbedSnippet, type EmbedTheme } from "@/lib/embed-snippet";

export function CopyButton(props: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink active:translate-y-[1px]"
    >
      {copied ? (
        <Check size={13} aria-hidden className="text-success" />
      ) : (
        <Copy size={13} aria-hidden />
      )}
      {copied ? "Copied" : props.label}
    </button>
  );
}

function CopyEmbedButton(props: { snapshotUrl: string }) {
  const [theme, setTheme] = useState<EmbedTheme>("auto");
  const [copied, setCopied] = useState(false);

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-panel p-1">
      <label className="inline-flex items-center gap-1.5 pl-2 text-xs text-ink-faint">
        <span>Theme</span>
        <select
          aria-label="Embed theme"
          value={theme}
          onChange={(event) => setTheme(event.target.value as EmbedTheme)}
          className="rounded-md bg-transparent px-1 py-1.5 text-xs text-ink outline-none"
        >
          <option value="auto">Auto</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <button
        type="button"
        aria-label="Copy embed code"
        onClick={() => {
          void navigator.clipboard.writeText(buildEmbedSnippet(props.snapshotUrl, theme)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink active:translate-y-[1px]"
      >
        {copied ? <Check size={13} aria-hidden className="text-success" /> : <Copy size={13} aria-hidden />}
        {copied ? "Copied" : "Copy embed code"}
      </button>
    </div>
  );
}

export function SnapshotActions(props: {
  importCommand: string;
  deepLink: string;
  snapshotUrl: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex flex-wrap items-stretch gap-2.5 ${props.className ?? ""}`}>
      <a
        href={props.deepLink}
        className="inline-flex flex-none items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-strong active:translate-y-[1px]"
      >
        Open in PromptBranch
        <ArrowUpRight size={15} aria-hidden />
      </a>
      <CopyEmbedButton snapshotUrl={props.snapshotUrl} />
      {/* This deep link opens a review flow on devices with PromptBranch installed. */}
      <div className="flex min-w-[280px] flex-1 items-stretch overflow-hidden rounded-lg border border-line bg-panel font-mono text-[13px]">
        <span
          aria-hidden
          className="flex select-none items-center border-r border-line bg-raised px-3 text-ink-faint"
        >
          $
        </span>
        <button
          type="button"
          title="Copy import command"
          onClick={() => {
            void navigator.clipboard.writeText(props.importCommand).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3.5 py-[7px] text-left leading-5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          <span className="truncate">{props.importCommand}</span>
          {copied ? (
            <Check size={15} aria-hidden className="shrink-0 text-success" />
          ) : (
            <Copy size={15} aria-hidden className="shrink-0 text-ink-faint" />
          )}
        </button>
      </div>
    </div>
  );
}
