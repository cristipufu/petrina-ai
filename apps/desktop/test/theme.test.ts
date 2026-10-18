import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/** Channels of a #rgb, #rrggbb or rgb()/rgba() colour. */
function channels(input: string): [number, number, number, number] {
  const value = input.trim();
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? [...value.slice(1)].map((part) => part + part).join("") : value.slice(1, 7);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length > 3 ? parts[3]! : 1];
}

/** Contrast of two computed colours. A translucent background is read over `behind`. */
function contrastPainted(front: string, back: string, behind = "rgb(0, 0, 0)"): number {
  const fg = channels(front);
  let bg = channels(back);
  if (bg[3] < 1) {
    const base = channels(behind);
    bg = [
      bg[0] * bg[3] + base[0] * (1 - bg[3]),
      bg[1] * bg[3] + base[1] * (1 - bg[3]),
      bg[2] * bg[3] + base[2] * (1 - bg[3]),
      1,
    ];
  }
  const lum = (rgb: [number, number, number, number]) => {
    const linear = (part: number) => {
      const value = part / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  };
  const hi = Math.max(lum(fg), lum(bg));
  const lo = Math.min(lum(fg), lum(bg));
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

  it("paints Next and the action line as quiet small text, readable in every look including hover", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const hoverAt = css.indexOf(".card:is(:hover, :focus-within) .card-next[data-full]::after");
    const hoverRule = css.slice(hoverAt, css.indexOf("}", hoverAt));
    expect(hoverRule).toContain("color: var(--text-2)");
    expect(hoverRule).toContain("background: var(--card-face)");
    expect(hoverRule).toContain("font-size: var(--fs-meta)");
    expect(hoverRule).toContain("font-weight: 400");
    expect(hoverRule).not.toContain("on-lead");
    expect(hoverRule).not.toContain("font-weight: 500");

    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      for (const theme of themes) {
        applyTheme(theme);
        const host = document.createElement("div");
        host.innerHTML = `
          <article class="card">
            <p class="card-status"><span>Working out the records</span></p>
            <div class="card-next"><p>Next: design review</p></div>
          </article>
          <article class="card held"></article>
          <div class="sheet"><div class="now"><div class="now-line">Reading the code</div></div></div>
          <div class="sheet"><div class="now needs-you"><div class="now-line">The to-do it was on</div></div></div>
          <div class="sheet"><div class="now failed"><div class="now-line">Reading the code</div></div></div>
          <div class="hover-probe" style="background: var(--hover)"></div>
          <div class="surface-probe" style="background: var(--surface)"></div>
          <div class="held-probe" style="background: var(--held)"></div>`;
        document.body.append(host);
        const next = host.querySelector<HTMLElement>(".card-next p");
        const action = host.querySelector<HTMLElement>(".now-line");
        const status = host.querySelector<HTMLElement>(".card-status");
        if (!next || !action || !status) throw new Error("missing line");
        const nextCss = getComputedStyle(next);
        const actionCss = getComputedStyle(action);
        expect(nextCss.fontSize, theme.id).toBe("12px");
        expect(actionCss.fontSize, theme.id).toBe("12px");
        expect(nextCss.lineHeight, theme.id).toBe("16px");
        expect(actionCss.lineHeight, theme.id).toBe("16px");
        expect(nextCss.fontWeight, theme.id).toBe("400");
        expect(actionCss.fontWeight, theme.id).toBe("400");
        expect(nextCss.color, theme.id).toBe(actionCss.color);
        const px = (size: string) => size.endsWith("rem") ? parseFloat(size) * 16 : parseFloat(size);
        expect(px(getComputedStyle(status).fontSize), `${theme.id} keeps one larger main line`).toBeGreaterThan(px(nextCss.fontSize));
        expect(host.querySelectorAll(".card-status")).toHaveLength(1);
        expect(getComputedStyle(host.querySelector(".card")!).backgroundColor, `${theme.id} card`).toBe(getComputedStyle(host.querySelector(".surface-probe")!).backgroundColor);
        expect(getComputedStyle(host.querySelector(".card.held")!).backgroundColor, `${theme.id} held card`).toBe(getComputedStyle(host.querySelector(".held-probe")!).backgroundColor);

        const sheet = getComputedStyle(host.querySelector(".sheet")!).backgroundColor;
        const surfaces: [string, Element][] = [
          ["a card", host.querySelector(".card")!],
          ["a held card", host.querySelector(".card.held")!],
          ["Right now", host.querySelector(".now")!],
          ["Right now when it needs you", host.querySelector(".now.needs-you")!],
          ["Right now when it is stuck", host.querySelector(".now.failed")!],
          ["hover", host.querySelector(".hover-probe")!],
        ];
        for (const [name, surface] of surfaces) {
          const bg = getComputedStyle(surface).backgroundColor;
          expect(contrastPainted(nextCss.color, bg, sheet), `${theme.id} Next on ${name}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastPainted(actionCss.color, bg, sheet), `${theme.id} action on ${name}`).toBeGreaterThanOrEqual(4.5);
        }
        host.remove();
      }
    } finally {
      style.remove();
    }
  });
});
