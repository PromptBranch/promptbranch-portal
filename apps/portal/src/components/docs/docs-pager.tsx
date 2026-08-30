import Link from "next/link";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react/dist/ssr";

interface DocsPagerProps {
  prev: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
}

export function DocsPager({ prev, next }: DocsPagerProps) {
  if (!prev && !next) return null;

  return (
    <div className="mt-14 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-line pt-6">
      {prev ? (
        <Link
          href={`/docs/${prev.slug}`}
          className="group flex flex-1 w-full sm:w-auto items-center gap-3 rounded-xl border border-line bg-panel p-4 transition-all hover:border-line-strong hover:bg-hover"
        >
          <ArrowLeft size={18} className="text-ink-faint transition-transform group-hover:-translate-x-1" />
          <div className="flex flex-col text-left">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Previous</span>
            <span className="text-sm font-semibold text-ink">{prev.title}</span>
          </div>
        </Link>
      ) : (
        <div className="hidden sm:block flex-1" />
      )}

      {next ? (
        <Link
          href={`/docs/${next.slug}`}
          className="group flex flex-1 w-full sm:w-auto items-center justify-between gap-3 rounded-xl border border-line bg-panel p-4 transition-all hover:border-line-strong hover:bg-hover text-right"
        >
          <div className="flex flex-col text-right ml-auto">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Next</span>
            <span className="text-sm font-semibold text-ink">{next.title}</span>
          </div>
          <ArrowRight size={18} className="text-ink-faint transition-transform group-hover:translate-x-1" />
        </Link>
      ) : (
        <div className="hidden sm:block flex-1" />
      )}
    </div>
  );
}
