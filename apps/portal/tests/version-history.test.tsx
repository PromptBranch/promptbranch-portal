// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@promptbranch/share";
import { VersionHistory } from "@/components/version-history";

const history: HistoryEntry[] = [
  { version: 1, content: "line one\nline two", changeNote: "first" },
  { version: 2, content: "line one\nline 2", changeNote: "tweak" },
];

describe("VersionHistory", () => {
  it("lists every history version plus 'current' in both pickers", () => {
    render(<VersionHistory history={history} current={"line one\nline three"} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["v1", "v2", "current", "v1", "v2", "current"]);
  });

  it("defaults to diffing v1 against current", () => {
    const { container } = render(<VersionHistory history={history} current={"line one\nline three"} />);
    const removed = container.querySelector(".bg-diff-del-bg");
    const added = container.querySelector(".bg-diff-add-bg");
    expect(removed?.textContent).toContain("line two");
    expect(added?.textContent).toContain("line three");
    expect(container.querySelector(".text-ink-dim")?.textContent).toContain("line one");
  });
});
