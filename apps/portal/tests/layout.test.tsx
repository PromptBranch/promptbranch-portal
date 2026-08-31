import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers([["x-nonce", "test-nonce"]])),
}));

import RootLayout from "@/app/layout";

describe("root layout", () => {
  it("advertises the LLM-readable site index to agents", async () => {
    const page = await RootLayout({ children: <main>Content</main> });
    const head = Children.toArray(page.props.children).find(
      (child) => isValidElement<{ children?: ReactNode }>(child) && child.type === "head",
    );
    const describedBy = isValidElement<{ children?: ReactNode }>(head)
      ? Children.toArray(head.props.children).find(
          (child) =>
            isValidElement<{ rel?: string }>(child) && child.type === "link" && child.props.rel === "describedby",
        )
      : null;

    expect(describedBy).toMatchObject({ props: { href: "/llms.txt", type: "text/plain" } });
  });
});
