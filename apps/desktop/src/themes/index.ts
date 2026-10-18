import { clay } from "./clay";
import { ember } from "./ember";
import { fathom } from "./fathom";
import { ink } from "./ink";
import { midnight } from "./midnight";
import { tide } from "./tide";
import type { Theme } from "./type";

export type { Theme } from "./type";
export { cssVars } from "./css";

/**
 * The looks a person can choose.
 *
 * To add a theme: copy the file closest to the look you want, export a Theme
 * from it, and add that theme to the list below. The top bar, Settings and the
 * command palette list whatever is here. Nothing else has to change.
 * A typeface the app does not already ship needs a file in public/fonts and an
 * @font-face in styles.css. Without that, the theme falls back to Inter.
 * Flow steps use a shared shadow for the theme's light or dark mode. Set
 * `nodeShadow` on the theme to replace it. Role chips use the shared colours
 * for the mode unless the theme sets `tones`.
 */
export const themes: readonly Theme[] = [ink, clay, tide, midnight, ember, fathom];

export const inkTheme = ink;
export const midnightTheme = midnight;

export function themeById(id: string): Theme | undefined {
  return themes.find((theme) => theme.id === id);
}
