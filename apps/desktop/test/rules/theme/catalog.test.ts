// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cssVars, themes } from "../../../src/themes";

function channel(hex: string, shift: number): number {
  const value = parseInt(hex.slice(shift, shift + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

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
      // Next and the action line use the quiet colour. It has to clear the card, a held card,
      // Right now (including when it needs you or is stuck) and the hover surface.
      expect(contrast(colors.text2, colors.surface), `${theme.id} quiet text on a card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text2, colors.held), `${theme.id} quiet text on a held card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text2, colors.sunken), `${theme.id} quiet text on Right now`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.text2, colors.hover), `${theme.id} quiet text on hover`).toBeGreaterThanOrEqual(4.5);
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
});
