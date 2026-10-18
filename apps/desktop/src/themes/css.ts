import type { Theme, ThemeColors } from "./type";
import { darkTones, lightTones } from "./tones";

const COLOR: Record<keyof ThemeColors, string> = {
  bg: "--bg",
  surface: "--surface",
  sunken: "--sunken",
  hover: "--hover",
  held: "--held",
  selected: "--selected",
  line: "--line",
  lineStrong: "--line-strong",
  field: "--field",
  focus: "--focus",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  accentText: "--accent-text",
  onAccent: "--on-accent",
  suggest: "--suggest",
  suggestLine: "--suggest-line",
  lead: "--lead",
  leadHover: "--lead-hover",
  onLead: "--on-lead",
  amber: "--amber",
  amberText: "--amber-text",
  amberSoft: "--amber-soft",
  amberLine: "--amber-line",
  green: "--green",
  greenText: "--green-text",
  greenSoft: "--green-soft",
  red: "--red",
  redText: "--red-text",
  redSoft: "--red-soft",
  blue: "--blue",
  blueText: "--blue-text",
  blueSoft: "--blue-soft",
  slate: "--slate",
  badge: "--badge",
  onBadge: "--on-badge",
  shadowCard: "--shadow-card",
  shadowLift: "--shadow-lift",
  shadowPop: "--shadow-pop",
};

const LIGHT_NODE_SHADOW = "0 1px 2px rgba(0, 0, 0, 0.06), 0 8px 18px rgba(0, 0, 0, 0.04)";
const DARK_NODE_SHADOW = "0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 18px rgba(0, 0, 0, 0.18)";

/** Every custom property a theme sets on the page. Missing shape values are not filled in here. */
export function cssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {
    "--font": theme.font,
    "--font-display": theme.displayFont,
    "--display-weight": String(theme.displayWeight),
    "--display-track": theme.displayTrack,
    "--body-track": theme.bodyTrack,
    "--logo-from": theme.logoFrom,
    "--logo-to": theme.logoTo,
    "--radius": theme.radius,
    "--radius-sm": theme.radiusSm,
    "--sheet-radius": theme.sheetRadius,
    "--card-pad": theme.cardPad,
    "--card-gap": theme.cardGap,
    "--board-pad": theme.boardPad,
    "--section-gap": theme.sectionGap,
    "--canvas": theme.canvas,
    "--canvas-dot": theme.canvasDot,
    "--canvas-dot-size": theme.canvasDotSize,
    "--you-fill": theme.youFill,
    "--node-radius": theme.nodeRadius,
    "--node-shadow": theme.nodeShadow ?? (theme.mode === "dark" ? DARK_NODE_SHADOW : LIGHT_NODE_SHADOW),
    "--scrim": theme.scrim,
  };
  for (const key of Object.keys(COLOR) as (keyof ThemeColors)[]) vars[COLOR[key]] = theme.colors[key];
  return { ...vars, ...(theme.mode === "dark" ? darkTones : lightTones), ...theme.tones };
}
