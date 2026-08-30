import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Viewer chrome shared by the snapshot page, 404 and 410 views. Uses the
 * same brand mark as the landing page so every portal surface reads as one
 * product.
 */
export function Topbar() {
  return (
    <header className="topbar">
      <a href="/" className="topbar-brand">
        <Image src="/brand-icon.png" alt="" width={20} height={20} className="rounded-[5px]" />
        PromptBranch
      </a>
      <ThemeToggle />
    </header>
  );
}
