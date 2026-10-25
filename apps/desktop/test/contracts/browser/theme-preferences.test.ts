import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, initialTheme } from "../../../src/theme";
import { themes } from "../../../src/themes";

const KEY = "petrina.theme";

afterEach(() => {
  localStorage.removeItem(KEY);
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeId;
});

describe("themes", () => {
  it("remembers a look, and reads an older light or dark save as Ink or Midnight", () => {
    localStorage.setItem(KEY, "light");
    expect(initialTheme().id).toBe("ink");
    localStorage.setItem(KEY, "dark");
    expect(initialTheme().id).toBe("midnight");
    localStorage.setItem(KEY, "clay");
    expect(initialTheme().id).toBe("clay");
    localStorage.setItem(KEY, "no-such-theme");
    const original = window.matchMedia.bind(window);
    const media = (dark: boolean) => {
      window.matchMedia = ((query: string) => ({ matches: dark && query.includes("dark"), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    };
    try {
      media(true);
      expect(initialTheme().id).toBe("midnight");
      localStorage.removeItem(KEY);
      media(false);
      expect(initialTheme().id).toBe("ink");
    } finally {
      window.matchMedia = original;
    }
  });

  it("paints the look on the page and replaces it with the next one", () => {
    const clay = themes.find((theme) => theme.id === "clay");
    const midnight = themes.find((theme) => theme.id === "midnight");
    if (!clay || !midnight) throw new Error("missing theme");
    applyTheme(clay);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themeId).toBe("clay");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--accent").trim()).toBe("#a34720");
    expect(document.documentElement.style.getPropertyValue("--font-display")).toContain("Fraunces");
    expect(localStorage.getItem(KEY)).toBe("clay");
    applyTheme(midnight);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--accent").trim()).toBe("#5c5ee0");
    expect(document.documentElement.style.getPropertyValue("--canvas").trim()).toBe("#0c0e13");
    expect(localStorage.getItem(KEY)).toBe("midnight");
  });
});
