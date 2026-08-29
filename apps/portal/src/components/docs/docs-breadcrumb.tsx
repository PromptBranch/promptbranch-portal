import Link from "next/link";
import { CaretRight } from "@phosphor-icons/react/dist/ssr";

interface DocsBreadcrumbProps {
  category: string;
  title: string;
}

export function DocsBreadcrumb({ category, title }: DocsBreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1.5 text-xs text-ink-dim mb-4" aria-label="Breadcrumbs">
      <Link href="/docs" className="transition-colors hover:text-ink">
        Docs
      </Link>
      <CaretRight size={12} className="text-ink-faint" />
      <span className="text-ink-dim">{category}</span>
      <CaretRight size={12} className="text-ink-faint" />
      <span className="font-semibold text-ink">{title}</span>
    </nav>
  );
}
