// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home, { metadata } from "@/app/page";

const REPO = "https://github.com/PromptBranch/promptbranch";
const RELEASES = `${REPO}/releases`;

describe("landing page", () => {
  it("renders the hero with value proposition and primary CTAs", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Version control for your AI prompts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/organize, version, evaluate, and share the prompts you rely on/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: "Download" }),
    ).toHaveAttribute("href", RELEASES);
    expect(screen.getAllByRole("link", { name: /Source code/ })[0]).toHaveAttribute("href", REPO);
    expect(screen.getAllByAltText(/The PromptBranch desktop app/)).toHaveLength(2);
  });

  it("renders a theme toggle and both hero screenshot variants", () => {
    render(<Home />);
    expect(
      screen.getByRole("button", { name: /Switch to (light|dark) mode/ }),
    ).toBeInTheDocument();
    const { container } = render(<Home />);
    expect(container.querySelector(".theme-dark-img")).toBeInTheDocument();
    expect(container.querySelector(".theme-light-img")).toBeInTheDocument();
  });

  it("renders the four feature highlights", () => {
    render(<Home />);
    for (const title of [
      "Branching version history",
      "Evidence over vibes",
      "Built for coding agents",
      "Local-first and private",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("links every available desktop platform card to releases with neutral styling", () => {
    render(<Home />);
    for (const [name, note] of [
      ["macOS", "Apple Silicon & Intel"],
      ["Windows", "x64 & ARM64"],
      ["Linux", "AppImage & deb"],
    ]) {
      const platformLink = screen.getByRole("link", {
        name: new RegExp(`${name}.*${note}.*Available`),
      });
      expect(platformLink).toHaveAttribute("href", RELEASES);
      expect(platformLink).toHaveClass("border-line", "bg-panel");
      expect(platformLink).not.toHaveClass("border-success/35", "bg-success/5");
    }

    expect(screen.getAllByText("Available")).toHaveLength(3);
    for (const status of screen.getAllByText("Available")) {
      expect(status).toHaveClass("text-ink-faint");
      expect(status).not.toHaveClass("text-success");
    }
    expect(
      screen.getByText(/Downloads are available for macOS, Windows, and Linux\./),
    ).toBeInTheDocument();
  });

  it("explains prompt sharing and links the customer guide", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Share a prompt when you choose" })).toBeInTheDocument();
    expect(
      screen.getByText(/Publish an immutable snapshot, review the secret scan, and revoke the link later if needed\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Learn about sharing" })).toHaveAttribute(
      "href",
      "/docs/sharing/link-sharing-and-portal",
    );
  });

  it("links to docs and issues in the footer, all on the public repo", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute(
      "href",
      "/docs",
    );
    expect(screen.getByRole("link", { name: "Report an issue" })).toHaveAttribute(
      "href",
      `${REPO}/issues`,
    );
    expect(screen.queryByRole("link", { name: "Releases" })).toBeNull();
  });

  it("contains no em-dashes or en-dashes in visible copy", () => {
    const { container } = render(<Home />);
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("exports indexable SEO metadata with canonical, OG, and Twitter cards", () => {
    expect(metadata.title).toEqual({ absolute: "PromptBranch: Version control for AI prompts" });
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.openGraph).toMatchObject({
      url: "/",
      siteName: "PromptBranch",
      type: "website",
      images: [{ url: "/app-screenshot.png", width: 2880, height: 1630 }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    // Landing page must be indexable: no robots restrictions set.
    expect(metadata.robots).toBeUndefined();
  });

  it("embeds JSON-LD structured data for search engines and AI agents", () => {
    const { container } = render(<Home />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeInTheDocument();
    const parsed = JSON.parse(script!.textContent ?? "{}") as {
      "@graph": Array<{ "@type": string; url?: string }>;
    };
    const types = parsed["@graph"].map((node) => node["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    expect(parsed["@graph"][0]?.url).toMatch(/^https?:\/\//);
  });
});
