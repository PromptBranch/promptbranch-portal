// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CodeBox } from "@/components/code-box";

function renderBox(overrides: Partial<Parameters<typeof CodeBox>[0]> = {}) {
  return render(
    <CodeBox
      contentHtml="<p>rendered</p>"
      sourceHtml='<pre class="shiki"><span class="line">source</span></pre>'
      markdown="# raw"
      {...overrides}
    />,
  );
}

describe("CodeBox", () => {
  it("shows the filename tab, both panes and a copy button", () => {
    renderBox();
    expect(screen.getByText("prompt.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByText("rendered")).toBeInTheDocument();
    expect(screen.getByText("source")).toBeInTheDocument();
  });

  it("defaults to the rendered view and hides the source pane", () => {
    const { container } = renderBox();
    const box = container.querySelector(".code-box")!;
    expect(box.getAttribute("data-view")).toBe("rendered");
  });

  it("switching to Source flips data-view on the code box", async () => {
    const { container } = renderBox();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector(".code-box")!.getAttribute("data-view")).toBe("source");
    await user.click(screen.getByRole("button", { name: "Rendered" }));
    expect(container.querySelector(".code-box")!.getAttribute("data-view")).toBe("rendered");
  });
});
