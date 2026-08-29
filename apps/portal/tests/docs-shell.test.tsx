// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocsShell } from "@/components/docs/docs-shell";
import type { DocCategory } from "@/lib/docs";

// DocsShell derives the active nav item from the URL; Next's App Router
// context is absent under vitest, so pin the pathname via a hoisted holder.
const router = vi.hoisted(() => ({ pathname: "/docs/features/prompt-management" }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    usePathname: () => router.pathname,
    // DocsSearchModal calls useRouter; give it a no-op since no router mounts.
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  };
});

const navigation: DocCategory[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    items: [
      {
        slug: "getting-started/overview",
        slugArray: ["getting-started", "overview"],
        title: "Overview & Philosophy",
        description: "",
      },
    ],
  },
  {
    id: "features",
    title: "Features & Workflows",
    items: [
      {
        slug: "features/prompt-management",
        slugArray: ["features", "prompt-management"],
        title: "Prompt Management & Versioning",
        description: "",
      },
    ],
  },
];

function renderShell() {
  render(
    <DocsShell navigation={navigation} searchIndex={[]}>
      <div />
    </DocsShell>,
  );
}

const ACTIVE_CLASS = "bg-accent-soft";

describe("docs sidebar active state", () => {
  it("highlights the item matching the current pathname", () => {
    router.pathname = "/docs/features/prompt-management";
    renderShell();

    const active = screen.getByRole("link", { name: "Prompt Management & Versioning" });
    expect(active.classList.contains(ACTIVE_CLASS)).toBe(true);

    const inactive = screen.getByRole("link", { name: "Overview & Philosophy" });
    expect(inactive.classList.contains(ACTIVE_CLASS)).toBe(false);
  });

  it("highlights the overview item on the /docs index", () => {
    router.pathname = "/docs";
    renderShell();

    const active = screen.getByRole("link", { name: "Overview & Philosophy" });
    expect(active.classList.contains(ACTIVE_CLASS)).toBe(true);
  });
});
