// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import { THEME_STORAGE_KEY, themeInitScript } from "@/lib/theme";

// Node 26 defines a global localStorage getter that returns undefined without
// --localstorage-file, shadowing jsdom's — so tests stub a real Storage.
function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

// jsdom keeps documentElement across tests in a file, so reset the theme
// state the toggle reads on mount; a fresh store per test keeps them isolated.
beforeEach(() => {
  delete document.documentElement.dataset.theme;
  vi.stubGlobal("localStorage", createStorage());
});

afterEach(() => vi.unstubAllGlobals());

describe("theme toggle", () => {
  it("flips data-theme, persists the choice, and swaps the aria-label", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Switch to light mode" });

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });

  it("flips back to dark on a second click", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Switch to light mode" });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
  });

  it("builds the pre-paint init script from the same storage key", () => {
    expect(themeInitScript()).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});
