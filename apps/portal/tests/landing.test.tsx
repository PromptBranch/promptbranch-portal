// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home, { metadata } from "@/app/page";

const REPO = "https://github.com/PromptBranch/promptbranch";
const RELEASES = `${REPO}/releases`;
const X_PROFILE = "https://x.com/PromptBranch";
const PROMPT_FRENZY_DIRECTORY = "https://www.promptfrenzy.com/directory";
const PROMPT_FRENZY_BADGE_DARK =
  "https://www.promptfrenzy.com/badges/directory-mono-dark.svg";
const PROMPT_FRENZY_BADGE_LIGHT =
  "https://www.promptfrenzy.com/badges/directory-mono-light.svg";

describe("landing page", async () => {
  it("renders the hero with value proposition and primary CTAs", async () => {
    render(await Home());
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

  it("renders a theme toggle and both hero screenshot variants", async () => {
    render(await Home());
    expect(
      screen.getByRole("button", { name: /Switch to (light|dark) mode/ }),
    ).toBeInTheDocument();
    const { container } = render(await Home());
    expect(container.querySelector(".theme-dark-img")).toBeInTheDocument();
    expect(container.querySelector(".theme-light-img")).toBeInTheDocument();
  });

  it("renders the four feature highlights", async () => {
    render(await Home());
    for (const title of [
      "Branching version history",
      "Evidence over vibes",
      "Built for coding agents",
      "Local-first and private",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("links every available desktop platform card to releases with neutral styling", async () => {
    render(await Home());
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

  it("invites visitors to follow PromptBranch on X from the hero", async () => {
    render(await Home());
    const hero = screen
      .getByRole("heading", { level: 1, name: "Version control for your AI prompts" })
      .closest("section");
    expect(hero).toBeInTheDocument();
    expect(
      within(hero as HTMLElement).getByText("@PromptBranch for updates, tips, and tricks."),
    ).toBeInTheDocument();
    const followLink = within(hero as HTMLElement).getByRole("link", {
      name: /Follow us on X/,
    });
    expect(followLink).toHaveAttribute("href", X_PROFILE);
    expect(followLink).toHaveAttribute("target", "_blank");
  });

  it("explains prompt sharing and links the customer guide", async () => {
    render(await Home());
    expect(screen.getByRole("heading", { name: "Share a prompt when you choose" })).toBeInTheDocument();
    expect(
      screen.getByText(/Publish an immutable snapshot, review the secret scan, and revoke the link later if needed\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Learn about sharing" })).toHaveAttribute(
      "href",
      "/docs/sharing/link-sharing-and-portal",
    );
  });

  it("links to docs and issues in the footer, all on the public repo", async () => {
    render(await Home());
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

  it("links to PromptBranch on X from the header", async () => {
    render(await Home());
    const xLink = within(screen.getByRole("banner")).getByRole("link", {
      name: "PromptBranch on X",
    });
    expect(xLink).toHaveAttribute("href", X_PROFILE);
    expect(xLink.querySelector("svg")).toBeInTheDocument();
  });

  it("allows the header controls to wrap on narrow screens", async () => {
    const { container } = render(await Home());
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("min-h-16", "flex-wrap", "py-3");
    expect(within(header).getByRole("navigation")).toHaveClass("ml-auto", "gap-3");
    expect(container.firstElementChild).toHaveClass("overflow-x-hidden");
  });

  it("links to PromptBranch on X from the footer", async () => {
    render(await Home());
    const xLink = within(screen.getByRole("contentinfo")).getByRole("link", {
      name: "PromptBranch on X",
    });
    expect(xLink).toHaveAttribute("href", X_PROFILE);
    expect(xLink.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the crawlable PromptFrenzy directory badge below the repository prompt", async () => {
    render(await Home());
    const downloadSection = screen
      .getByRole("heading", { name: "Download PromptBranch" })
      .closest("section");
    expect(downloadSection).toBeInTheDocument();

    const watchLink = within(downloadSection as HTMLElement).getByRole("link", {
      name: "Watch the repository",
    });
    const badgeLink = within(downloadSection as HTMLElement).getByRole("link", {
      name: "Featured on PromptFrenzy AI Directory",
    });

    expect(watchLink.compareDocumentPosition(badgeLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      within(screen.getByRole("contentinfo")).queryByRole("link", {
        name: "Featured on PromptFrenzy AI Directory",
      }),
    ).toBeNull();
    expect(badgeLink).toHaveAttribute("href", PROMPT_FRENZY_DIRECTORY);
    expect(badgeLink).toHaveAttribute("target", "_blank");
    expect(badgeLink).toHaveAttribute("rel", "noopener");
    expect(badgeLink).toHaveAttribute("title", "Featured on PromptFrenzy AI Directory");

    const badgeImages = within(badgeLink).getAllByRole("img", {
      name: "Featured on PromptFrenzy AI Directory",
    });
    expect(badgeImages).toHaveLength(2);

    const darkModeBadge = badgeImages.find(
      (image) => image.getAttribute("src") === PROMPT_FRENZY_BADGE_LIGHT,
    );
    const lightModeBadge = badgeImages.find(
      (image) => image.getAttribute("src") === PROMPT_FRENZY_BADGE_DARK,
    );
    expect(darkModeBadge).toHaveClass("theme-dark-img");
    expect(lightModeBadge).toHaveClass("theme-light-img");

    for (const badgeImage of badgeImages) {
      expect(badgeImage).toHaveAttribute("width", "220");
      expect(badgeImage).toHaveAttribute("height", "44");
      expect(badgeImage).toHaveAttribute("loading", "lazy");
    }
  });

  it("contains no em-dashes or en-dashes in visible copy", async () => {
    const { container } = render(await Home());
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("exports indexable SEO metadata with canonical, OG, and Twitter cards", async () => {
    expect(metadata.title).toEqual({ absolute: "PromptBranch: Version control for AI prompts" });
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.openGraph).toMatchObject({
      url: "/",
      siteName: "PromptBranch",
      type: "website",
      images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", images: ["/opengraph-image"] });
    // Landing page must be indexable: no robots restrictions set.
    expect(metadata.robots).toBeUndefined();
  });

  it("embeds JSON-LD structured data for search engines and AI agents", async () => {
    const { container } = render(await Home());
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeInTheDocument();
    const parsed = JSON.parse(script!.textContent ?? "{}") as {
      "@graph": Array<{
        "@type": string;
        url?: string;
        downloadUrl?: string;
        sameAs?: string;
        featureList?: string[];
      }>;
    };
    const types = parsed["@graph"].map((node) => node["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    expect(parsed["@graph"][0]?.url).toMatch(/^https?:\/\//);
    expect(parsed["@graph"].find((node) => node["@type"] === "SoftwareApplication")).toMatchObject({
      downloadUrl: "https://github.com/PromptBranch/promptbranch/releases",
      sameAs: "https://github.com/PromptBranch/promptbranch",
      featureList: [
        "Branching version history",
        "Evidence-based prompt evaluation",
        "Coding-agent integrations",
        "Local-first private storage",
      ],
    });
  });
});
