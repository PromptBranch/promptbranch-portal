"use client";

import { useRef, useState } from "react";

type View = "rendered" | "source";

/**
 * Segmented Rendered/Source control. Both panes are server-rendered
 * siblings; this flips the data-view attribute on the enclosing .code-box
 * and CSS decides visibility — no content is ever shipped as client JS.
 */
export function ViewToggle() {
  const [view, setView] = useState<View>("rendered");
  const ref = useRef<HTMLDivElement>(null);

  function select(next: View) {
    setView(next);
    ref.current?.closest(".code-box")?.setAttribute("data-view", next);
  }

  const button = (value: View, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={view === value}
      onClick={() => select(value)}
      className={
        view === value
          ? "rounded-md bg-raised px-3 py-1 text-xs font-medium text-ink shadow-sm transition-colors"
          : "rounded-md px-3 py-1 text-xs text-ink-faint transition-colors hover:text-ink-dim active:translate-y-[1px]"
      }
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Content view"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-app p-0.5"
    >
      {button("rendered", "Rendered")}
      {button("source", "Source")}
    </div>
  );
}
