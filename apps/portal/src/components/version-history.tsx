"use client";

import { useMemo, useState } from "react";
import { diffLines } from "diff";
import type { HistoryEntry } from "@promptbranch/share";

export function VersionHistory(props: { history: HistoryEntry[]; current: string }) {
  const versions = useMemo(
    () => [
      ...props.history.map((entry) => ({ label: `v${entry.version}`, content: entry.content })),
      { label: "current", content: props.current },
    ],
    [props.history, props.current],
  );
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(versions.length - 1);
  // noUncheckedIndexedAccess: out-of-range select values yield undefined content.
  const parts = useMemo(
    () => diffLines(versions[from]?.content ?? "", versions[to]?.content ?? ""),
    [versions, from, to],
  );

  return (
    <div className="mt-5">
      {/* faint, not dim: the diff's unchanged lines own .text-ink-dim (tests select it) */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-faint">
        <label htmlFor="diff-from">From</label>
        <select
          id="diff-from"
          value={from}
          onChange={(event) => setFrom(Number(event.target.value))}
          className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-ink transition-colors hover:border-line-strong"
        >
          {versions.map((version, index) => (
            <option key={version.label} value={index}>
              {version.label}
            </option>
          ))}
        </select>
        <label htmlFor="diff-to">To</label>
        <select
          id="diff-to"
          value={to}
          onChange={(event) => setTo(Number(event.target.value))}
          className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-ink transition-colors hover:border-line-strong"
        >
          {versions.map((version, index) => (
            <option key={version.label} value={index}>
              {version.label}
            </option>
          ))}
        </select>
      </div>
      <div className="code-box mt-5" data-view="rendered">
        <header className="code-box-bar">
          <span className="code-box-dots" aria-hidden>
            <i /> <i /> <i />
          </span>
          <span className="code-box-title">history.md</span>
          <span className="text-xs tabular-nums text-ink-faint">
            {versions[from]?.label} → {versions[to]?.label}
          </span>
        </header>
        <div className="code-box-pane overflow-x-auto">
          <pre className="diff-view font-mono text-[13px] leading-relaxed">
            {parts.map((part, index) => (
              <div
                key={index}
                className={
                  part.added
                    ? "diff-line bg-diff-add-bg text-diff-add-text"
                    : part.removed
                      ? "diff-line bg-diff-del-bg text-diff-del-text"
                      : "diff-line text-ink-dim"
                }
              >
                {part.value.replace(/\n$/, "")}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
