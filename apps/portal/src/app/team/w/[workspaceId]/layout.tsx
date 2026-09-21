import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { BookOpen, Gear, GitBranch, Users } from "@phosphor-icons/react/dist/ssr";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/team/sign-out-button";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Workspace-aware authenticated shell. Team surfaces are unlisted by design:
// noindex here, generic metadata (nothing derived from team content).

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false, follow: false },
};

const ROLE_BADGE = {
  owner: "bg-accent-soft text-accent",
  maintainer: "bg-accent-soft text-accent",
  contributor: "rounded-full border border-line px-2 py-0.5",
  viewer: "rounded-full border border-line px-2 py-0.5",
} as const;

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspacePage(workspaceId);
  const isOwner = workspace.role === "owner";
  const nav = [
    { href: `/team/w/${workspaceId}/library`, label: "Library", icon: BookOpen },
    { href: `/team/w/${workspaceId}/proposals`, label: "Proposals", icon: GitBranch },
    ...(isOwner
      ? [
          { href: `/team/w/${workspaceId}/settings/members`, label: "Members", icon: Users },
          { href: `/team/w/${workspaceId}/settings/general`, label: "Settings", icon: Gear },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-app text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/team" className="flex items-center gap-2.5">
            <Image src="/brand-icon.png" alt="" width={26} height={26} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-tight text-ink">PromptBranch</span>
          </Link>
          <span className="text-ink-faint">/</span>
          <span className="truncate text-sm font-medium text-ink-dim">{workspace.name}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-dim ${ROLE_BADGE[workspace.role]}`}>
            {workspace.role}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6">
        <nav aria-label="Workspace" className="flex w-44 flex-none flex-col gap-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <Icon size={15} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
