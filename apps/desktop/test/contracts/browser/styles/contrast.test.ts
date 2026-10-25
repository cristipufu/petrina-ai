import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "../../../../src/theme";
import { themes } from "../../../../src/themes";

const KEY = "petrina.theme";

function channels(input: string): [number, number, number, number] {
  const value = input.trim();
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? [...value.slice(1)].map((part) => part + part).join("") : value.slice(1, 7);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length > 3 ? parts[3]! : 1];
}

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
  it("paints Next and the action line as quiet small text, readable in every look including hover", () => {
    const css = readFileSync(resolve(__dirname, "../../../../src/styles.css"), "utf8");
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
          </article>
          <article class="card held"></article>
          <div class="sheet"><div class="now"><div class="now-line">Next: design review</div><div class="now-line">Reading the code</div></div></div>
          <div class="sheet"><div class="now needs-you"><div class="now-line">The to-do it was on</div></div></div>
          <div class="sheet"><div class="now failed"><div class="now-line">Reading the code</div></div></div>
          <div class="hover-probe" style="background: var(--hover)"></div>
          <div class="surface-probe" style="background: var(--surface)"></div>
          <div class="held-probe" style="background: var(--held)"></div>`;
        document.body.append(host);
        const next = host.querySelector<HTMLElement>(".now-line");
        const action = host.querySelector<HTMLElement>(".now-line + .now-line");
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
