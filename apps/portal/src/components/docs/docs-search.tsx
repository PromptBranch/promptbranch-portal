"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, X, ArrowRight, BookOpen } from "@phosphor-icons/react";
import type { DocSearchResult } from "@/lib/docs";

interface DocsSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  searchIndex: DocSearchResult[];
}

export function DocsSearchModal({ isOpen, onClose, searchIndex }: DocsSearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Global shortcut: ⌘K or /
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (isOpen) onClose();
        else {
          // Open search triggered by parent
        }
      }
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Filter items
  const filtered = query.trim()
    ? searchIndex.filter(
        (item) =>
          item.title.toLowerCase().includes(query.toLowerCase()) ||
          item.category.toLowerCase().includes(query.toLowerCase()) ||
          item.snippet.toLowerCase().includes(query.toLowerCase()),
      )
    : searchIndex.slice(0, 8);

  const handleSelect = (slug: string) => {
    onClose();
    router.push(`/docs/${slug}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      handleSelect(filtered[selectedIndex].slug);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 sm:pt-28 px-4 bg-app/80 backdrop-blur-md">
      <div
        className="w-full max-w-xl rounded-xl border border-line-strong bg-panel shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5 bg-raised/50">
          <MagnifyingGlass size={18} className="text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search docs, guides, tools, and schemas..."
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-ink-faint hover:text-ink"
            >
              <X size={16} />
            </button>
          )}
          <kbd className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 flex flex-col gap-1">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-ink-dim">
              No results found for <span className="font-semibold text-ink">"{query}"</span>
            </div>
          ) : (
            filtered.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <button
                  key={item.slug}
                  type="button"
                  onClick={() => handleSelect(item.slug)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isSelected ? "bg-accent-soft" : "hover:bg-hover"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <BookOpen
                        size={14}
                        className={isSelected ? "text-accent" : "text-ink-faint"}
                      />
                      <span
                        className={`text-xs font-medium ${
                          isSelected ? "text-accent font-semibold" : "text-ink"
                        }`}
                      >
                        {item.title}
                      </span>
                    </div>
                    <span className="text-[11px] font-medium text-ink-faint uppercase tracking-wider">
                      {item.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-dim line-clamp-1 pl-5">
                    {item.snippet}
                  </p>
                </button>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between border-t border-line px-4 py-2 bg-raised/30 text-[11px] text-ink-faint">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded bg-panel px-1 py-0.5 border border-line">↑</kbd>{" "}
              <kbd className="rounded bg-panel px-1 py-0.5 border border-line">↓</kbd> navigate
            </span>
            <span>
              <kbd className="rounded bg-panel px-1 py-0.5 border border-line">↵</kbd> select
            </span>
          </div>
          <span>PromptBranch Documentation</span>
        </div>
      </div>
    </div>
  );
}
