import { describe, expect, it } from "vitest";
import { buildEmbedSnippet } from "@/lib/embed-snippet";

const ID = "V1StGXR8_Z5jdHi6B-myT";

describe("buildEmbedSnippet", () => {
  it("returns the exact two-line HTML snippet for the official portal", () => {
    expect(buildEmbedSnippet(`https://promptbranch.app/p/${ID}`)).toBe(
      `<div data-promptbranch-embed="https://promptbranch.app/p/${ID}"></div>\n` +
        `<script defer src="https://promptbranch.app/embed.js"></script>`,
    );
  });

  it("normalizes a self-hosted origin and keeps the widget same-origin", () => {
    expect(buildEmbedSnippet(`HTTPS://Portal.Example:443/p/${ID}`)).toBe(
      `<div data-promptbranch-embed="https://portal.example/p/${ID}"></div>\n` +
        `<script defer src="https://portal.example/embed.js"></script>`,
    );
  });

  it.each([
    `javascript:alert(1)`,
    `//promptbranch.app/p/${ID}`,
    `https://user:password@promptbranch.app/p/${ID}`,
    `https://promptbranch.app/p/${ID}?token=secret`,
    `https://promptbranch.app/p/${ID}#fragment`,
    `https://promptbranch.app/p/short`,
    `https://promptbranch.app/api/snapshots/${ID}`,
  ])("rejects non-canonical or unsafe share URL %s", (url) => {
    expect(() => buildEmbedSnippet(url)).toThrow();
  });

  it("never copies a delete token into embed HTML", () => {
    const url = `https://promptbranch.app/p/${ID}?deleteToken=private`;
    expect(() => buildEmbedSnippet(url)).toThrow();
  });
});
