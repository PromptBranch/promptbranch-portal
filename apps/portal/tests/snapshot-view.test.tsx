// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SnapshotPayload } from "@promptbranch/share";
import { SnapshotView } from "@/components/snapshot-view";

const snapshot: SnapshotPayload = {
  formatVersion: 1,
  title: "security-audit",
  description: "Review code for security issues",
  content: "You are a **security auditor**.",
  tags: ["security", "review"],
  publishedAt: "2026-08-25T12:00:00.000Z",
};

function renderView(overrides: Partial<SnapshotPayload> = {}) {
  return render(
    <SnapshotView
      id="V1StGXR8_Z5jdHi6B-myT"
      url="http://localhost:3000/p/V1StGXR8_Z5jdHi6B-myT"
      snapshot={{ ...snapshot, ...overrides }}
      publishedAt="2026-08-25T12:00:00.000Z"
      contentHtml="<p>You are a <strong>security auditor</strong>.</p>"
      sourceHtml='<pre class="shiki"><span class="line"># raw</span></pre>'
    />,
  );
}

describe("SnapshotView", () => {
  it("renders the top bar with wordmark link and theme toggle", () => {
    renderView();
    const home = screen.getByRole("link", { name: "PromptBranch" });
    expect(home).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /switch to (light|dark) mode/i })).toBeInTheDocument();
  });

  it("renders title, description, tags and the rendered content", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "security-audit" })).toBeInTheDocument();
    expect(screen.getByText("Review code for security issues")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("security auditor").tagName).toBe("STRONG");
  });

  it("offers the import command and the deep link, with no duplicate markdown copy", () => {
    renderView();
    // Copying lives in the code box's titlebar button; the header must not
    // duplicate it.
    expect(screen.queryByRole("button", { name: "Copy as Markdown" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "promptbranch import http://localhost:3000/p/V1StGXR8_Z5jdHi6B-myT" }),
    ).toBeInTheDocument();
    const deepLink = screen.getByRole("link", { name: "Open in PromptBranch" });
    expect(deepLink).toHaveAttribute(
      "href",
      "promptbranch://import?url=http%3A%2F%2Flocalhost%3A3000%2Fp%2FV1StGXR8_Z5jdHi6B-myT",
    );
  });

  it("mounts the code box with both views precomputed", () => {
    renderView();
    expect(screen.getByText("prompt.md")).toBeInTheDocument();
    expect(screen.getByText("security auditor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source" })).toBeInTheDocument();
  });

  it("hides the history section when the snapshot has no history", () => {
    renderView();
    expect(screen.queryByText("Version history")).not.toBeInTheDocument();
  });

  it("shows the history section when history is present", () => {
    renderView({ history: [{ version: 1, content: "draft", changeNote: "first" }] });
    expect(screen.getByText("Version history")).toBeInTheDocument();
  });
});
