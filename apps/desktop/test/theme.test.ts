import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, initialTheme } from "../src/theme";
import { cssVars, themes } from "../src/themes";

const KEY = "petrina.theme";

function channel(hex: string, shift: number): number {
  const value = parseInt(hex.slice(shift, shift + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

afterEach(() => {
  localStorage.removeItem(KEY);
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeId;
});

describe("themes", () => {
  it("lists six distinct looks a person can name", () => {
    expect(themes.map((theme) => theme.name)).toEqual(["Ink", "Clay", "Tide", "Midnight", "Ember", "Fathom"]);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
    for (const theme of themes) {
      expect(theme.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(theme.blurb.endsWith(".")).toBe(true);
      expect(theme.mode === "light" || theme.mode === "dark").toBe(true);
    }
  });

  it("keeps text readable and the accent off the semantic colours", () => {
    for (const theme of themes) {
      const { colors } = theme;
      expect(contrast(colors.text, colors.bg), `${theme.id} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text, colors.surface), `${theme.id} text on a card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text3, colors.bg), `${theme.id} metadata`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text3, colors.surface), `${theme.id} metadata on a card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.onAccent, colors.accent), `${theme.id} new task`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.amberText, theme.youFill), `${theme.id} needs you`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.field, theme.canvas), `${theme.id} flow outline`).toBeGreaterThanOrEqual(3);
      expect(colors.accent).not.toBe(colors.blue);
      expect(colors.accent).not.toBe(colors.green);
      expect(colors.accent).not.toBe(colors.amber);
    }
  });

  it("gives every look the same set of tokens, so a new theme cannot forget one", () => {
    const lists = themes.map((theme) => Object.keys(cssVars(theme)).sort());
    const first = lists[0];
    if (!first) throw new Error("no themes");
    for (const keys of lists.slice(1)) expect(keys).toEqual(first);
    expect(first).toEqual(expect.arrayContaining(["--bg", "--accent", "--on-accent", "--canvas", "--you-fill", "--font", "--font-display", "--sheet-radius", "--logo-from", "--scrim"]));
  });

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
