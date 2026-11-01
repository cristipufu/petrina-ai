import { TONES, type Tone } from "@petrina/core";

export interface TonePalette {
  readonly fg: string;
  readonly soft: string;
}

export interface ToneDescriptor {
  readonly name: string;
  readonly light: TonePalette;
  readonly dark: TonePalette;
}

/** Single source of truth for every `Tone` in light and dark modes, its display name, and its CSS rules. */
export const TONE_CATALOG: Readonly<Record<Tone, ToneDescriptor>> = {
  indigo: {
    name: "Indigo",
    light: { fg: "#3e4cc0", soft: "#e7ebfb" },
    dark: { fg: "#aeb6ff", soft: "rgba(143, 152, 255, 0.16)" },
  },
  orange: {
    name: "Orange",
    light: { fg: "#b45309", soft: "#fdecd9" },
    dark: { fg: "#f3a15b", soft: "rgba(243, 161, 91, 0.16)" },
  },
  violet: {
    name: "Violet",
    light: { fg: "#6d3fd0", soft: "#f0eafc" },
    dark: { fg: "#c4a6ff", soft: "rgba(178, 148, 255, 0.16)" },
  },
  purple: {
    name: "Purple",
    light: { fg: "#8a32b0", soft: "#f6e8fa" },
    dark: { fg: "#e0a4f4", soft: "rgba(212, 139, 240, 0.16)" },
  },
  pink: {
    name: "Pink",
    light: { fg: "#b4236a", soft: "#fbe6f0" },
    dark: { fg: "#f7a3cc", soft: "rgba(243, 131, 187, 0.16)" },
  },
  blue: {
    name: "Blue",
    light: { fg: "#1d5fd0", soft: "#e6effc" },
    dark: { fg: "#8eb6ff", soft: "rgba(107, 157, 255, 0.16)" },
  },
  green: {
    name: "Green",
    light: { fg: "#1a7340", soft: "#e3f6ea" },
    dark: { fg: "#7ed9a4", soft: "rgba(76, 198, 131, 0.16)" },
  },
  teal: {
    name: "Teal",
    light: { fg: "#0c726e", soft: "#dcf4f2" },
    dark: { fg: "#5ed4cc", soft: "rgba(63, 198, 191, 0.16)" },
  },
  slate: {
    name: "Slate",
    light: { fg: "#5c6570", soft: "#eceeef" },
    dark: { fg: "#b4bcc8", soft: "rgba(154, 158, 166, 0.16)" },
  },
  amber: {
    name: "Amber",
    light: { fg: "#92600a", soft: "#fbf1d4" },
    dark: { fg: "#f0c14a", soft: "rgba(240, 176, 60, 0.16)" },
  },
};

export function toneCssVars(mode: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const tone of TONES) {
    const palette = TONE_CATALOG[tone][mode];
    vars[`--t-${tone}`] = palette.fg;
    vars[`--t-${tone}-soft`] = palette.soft;
  }
  return vars;
}

export const lightTones: Readonly<Record<string, string>> = toneCssVars("light");
export const darkTones: Readonly<Record<string, string>> = toneCssVars("dark");

export function toneRulesCss(): string {
  return TONES.map((tone) => `.tone-${tone} { --tone: var(--t-${tone}); --tone-soft: var(--t-${tone}-soft); }`).join("\n");
}
