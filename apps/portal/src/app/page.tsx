import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  AppleLogo,
  ArrowUpRight,
  ChartLineUp,
  GitBranch,
  GithubLogo,
  LinuxLogo,
  Robot,
  ShieldCheck,
  WindowsLogo,
} from "@phosphor-icons/react/dist/ssr";
import { ThemeToggle } from "@/components/theme-toggle";
import { getEnv } from "@/lib/env";

// Canonical outbound links.
const LINKS = {
  repo: "https://github.com/PromptBranch/promptbranch",
  releases: "https://github.com/PromptBranch/promptbranch/releases",
  docs: "/docs",
  issues: "https://github.com/PromptBranch/promptbranch/issues",
} as const;


export const metadata: Metadata = {
  // Absolute: the layout's "%s · PromptBranch" template would double the brand.
  title: { absolute: "PromptBranch: Version control for AI prompts" },
  description:
    "PromptBranch is a local-first desktop app for organizing, versioning, evaluating, and sharing AI prompts.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "PromptBranch",
    description:
      "Local-first version control for AI prompts. Organize, evaluate, and share the prompts you rely on.",
    url: "/",
    siteName: "PromptBranch",
    type: "website",
    images: [{ url: "/app-screenshot.png", width: 2880, height: 1630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PromptBranch: Version control for AI prompts",
    description:
      "Local-first version control for AI prompts. Organize, evaluate, and share the prompts you rely on.",
    images: ["/app-screenshot.png"],
  },
};

const FEATURES = [
  {
    icon: GitBranch,
    title: "Branching version history",
    body: "Sequential versions, branches, diffs, and change notes keep every prompt's full evolution intact.",
    accent: false,
  },
  {
    icon: ChartLineUp,
    title: "Evidence over vibes",
    body: "Ratings, run logs, multi-model runs, and an LLM judge show which version actually performs.",
    accent: true,
  },
  {
    icon: Robot,
    title: "Built for coding agents",
    body: "The CLI and MCP server let agents fetch prompts, report results, and suggest variations. You approve.",
    accent: false,
  },
  {
    icon: ShieldCheck,
    title: "Local-first and private",
    body: "Your library is one SQLite file on your machine. Offline by default, no account required.",
    accent: true,
  },
] as const;

const PLATFORMS = [
  {
    icon: AppleLogo,
    name: "macOS",
    note: "Apple Silicon & Intel",
    status: "Available",
    href: LINKS.releases,
  },
  {
    icon: WindowsLogo,
    name: "Windows",
    note: "x64, per-user install",
    status: "Soon",
    href: null,
  },
  { icon: LinuxLogo, name: "Linux", note: "AppImage & deb", status: "Soon", href: null },
] as const;

export default function Home() {
  // Computed at render time (not module scope) so the runtime PUBLIC_BASE_URL
  // is used — Docker sets it per deployment, never at build time.
  const baseUrl = getEnv().PUBLIC_BASE_URL;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "PromptBranch", url: baseUrl },
      {
        "@type": "SoftwareApplication",
        name: "PromptBranch",
        url: baseUrl,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Windows, Linux",
        description:
          "Local-first desktop app for organizing, versioning, evaluating, and sharing AI prompts.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      {/* JSON-LD is a non-executable data block, so the strict script CSP
          intentionally needs no nonce here — browsers never run it, while
          search engines and AI agents parse it as structured data. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <Image src="/brand-icon.png" alt="" width={26} height={26} className="rounded-md" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">PromptBranch</span>
        </div>
        <nav className="flex items-center gap-5 text-sm">
          <Link href={LINKS.docs} className="hidden text-ink-dim transition-colors hover:text-ink sm:block">
            Docs
          </Link>
          <a
            href={LINKS.repo}
            className="hidden items-center gap-1.5 text-ink-dim transition-colors hover:text-ink sm:flex"
          >
            <GithubLogo size={16} aria-hidden />
            Source
          </a>
          <ThemeToggle />
          <a
            href={LINKS.releases}
            className="rounded-lg border border-line px-3.5 py-1.5 font-medium text-ink transition-colors hover:bg-hover active:translate-y-[1px]"
          >
            Download
          </a>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero: split layout, copy left, real product shot right. */}
        <section className="mx-auto grid w-full max-w-6xl gap-12 px-6 pt-14 pb-16 md:pt-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-10">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
              Local-first prompt versioning
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight text-ink md:text-5xl">
              Version control for your AI prompts
            </h1>
            <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-ink-dim">
              A local-first desktop app to organize, version, evaluate, and share the prompts you
              rely on.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={LINKS.releases}
                className="flex items-center gap-2 rounded-lg border border-line-strong px-5 py-2.5 font-medium text-ink transition-colors hover:bg-hover active:translate-y-[1px]"
              >
                <AppleLogo size={18} aria-hidden />
                Download
              </a>
              <a
                href={LINKS.repo}
                className="flex items-center gap-2 rounded-lg border border-line-strong px-5 py-2.5 font-medium text-ink transition-colors hover:bg-hover active:translate-y-[1px]"
              >
                <GithubLogo size={18} aria-hidden />
                Source code
              </a>
            </div>
          </div>

          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-10 rounded-full opacity-60 blur-3xl"
              style={{
                background:
                  "radial-gradient(closest-side, rgba(59, 130, 246, 0.14), transparent)",
              }}
            />
            <div className="relative rounded-xl border border-line bg-panel p-1.5 shadow-[0_32px_90px_-32px_rgba(59,130,246,0.35)]">
              <Image
                src="/app-screenshot.png"
                alt="The PromptBranch desktop app in dark mode: a prompt library with tagged, versioned prompts, the editor, and the evaluation inspector"
                width={2880}
                height={1630}
                priority
                className="theme-dark-img rounded-lg"
              />
              <Image
                src="/app-screenshot-light.png"
                alt="The PromptBranch desktop app in light mode: a prompt library with tagged, versioned prompts, the editor, and the evaluation inspector"
                width={2880}
                height={1634}
                priority
                className="theme-light-img rounded-lg"
              />
            </div>
          </div>
        </section>

        {/* Feature overview: 4 items, 2x2 grid with two tinted cells. */}
        <section className="border-t border-line">
          <div className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-ink md:text-3xl">
              The whole prompt lifecycle
            </h2>
            <p className="mt-3 max-w-[60ch] leading-relaxed text-ink-dim">
              From first draft to proven version, every step is tracked.
            </p>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className={`rounded-xl border p-6 transition-colors ${
                    feature.accent
                      ? "border-accent/25 bg-accent-soft/40 hover:border-accent/40"
                      : "border-line bg-panel hover:border-line-strong"
                  }`}
                >
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent">
                    <feature.icon size={18} aria-hidden />
                  </div>
                  <h3 className="mt-4 font-medium text-ink">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-dim">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Download: centered band, platform cards, and signing notes. */}
        <section className="border-t border-line">
          <div className="mx-auto w-full max-w-3xl px-6 py-16 text-center md:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-ink md:text-3xl">
              Download PromptBranch
            </h2>
            <p className="mt-3 leading-relaxed text-ink-dim">
              macOS builds are available now. Windows and Linux downloads are still in the works.
              macOS builds are signed and notarized.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {PLATFORMS.map((platform) => {
                const cardContent = (
                  <>
                    <platform.icon size={28} aria-hidden className="text-ink" />
                    <span className="font-medium text-ink">{platform.name}</span>
                    <span className="text-xs text-ink-dim">{platform.note}</span>
                    <span
                      className={
                        platform.href
                          ? "rounded-full border border-success/35 bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success"
                          : "rounded-full border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-faint"
                      }
                    >
                      {platform.status}
                    </span>
                  </>
                );

                return platform.href ? (
                  <a
                    key={platform.name}
                    href={platform.href}
                    className="flex flex-col items-center gap-2 rounded-xl border border-success/35 bg-success/5 px-4 py-5 transition-colors hover:bg-success/10 focus-visible:outline-success"
                  >
                    {cardContent}
                  </a>
                ) : (
                  <div
                    key={platform.name}
                    className="flex flex-col items-center gap-2 rounded-xl border border-line bg-panel px-4 py-5 opacity-70"
                  >
                    {cardContent}
                  </div>
                );
              })}
            </div>
            <p className="mt-6 text-sm text-ink-dim">
              Want to be first to try a build?{" "}
              <a
                href={LINKS.repo}
                className="inline-flex items-center gap-1 text-accent transition-colors hover:text-accent-strong"
              >
                Watch the repository
                <ArrowUpRight size={14} aria-hidden />
              </a>
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-8 text-sm text-ink-dim sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 PromptBranch</span>
          <nav className="flex flex-wrap items-center gap-5">
            <a href={LINKS.repo} className="transition-colors hover:text-ink">
              Source
            </a>
            <Link href={LINKS.docs} className="transition-colors hover:text-ink">
              Documentation
            </Link>
            <a href={LINKS.issues} className="transition-colors hover:text-ink">
              Report an issue
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
