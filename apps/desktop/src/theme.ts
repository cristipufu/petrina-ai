import { cssVars } from "./themes/css";
import { inkTheme, midnightTheme, themeById } from "./themes";
import type { Theme } from "./themes/type";

export type { Theme };

const KEY = "petrina.theme";
const applied = new Set<string>();

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage can be unavailable; fall back to the system setting.
    return null;
  }
}

function systemDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** The saved look, or Ink / Midnight when the system is light / dark. Older saves of "light" and "dark" map to those two. */
export function initialTheme(): Theme {
  const saved = readSaved();
  if (saved === "light") return inkTheme;
  if (saved === "dark") return midnightTheme;
  const found = saved ? themeById(saved) : undefined;
  if (found) return found;
  return systemDark() ? midnightTheme : inkTheme;
}

/** Paint the look before the first frame, and remember its id. Tokens the previous look set and this one omits are removed. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.dataset.themeId = theme.id;
  root.style.colorScheme = theme.mode;
  const next = cssVars(theme);
  for (const key of applied) {
    if (!(key in next)) root.style.removeProperty(key);
  }
  applied.clear();
  for (const [key, value] of Object.entries(next)) {
    root.style.setProperty(key, value);
    applied.add(key);
  }
  try {
    localStorage.setItem(KEY, theme.id);
  } catch {
    // Not fatal: the theme just won't be remembered.
  }
}
