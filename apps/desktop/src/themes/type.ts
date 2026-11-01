/** One look. Copy a theme file, change these values, and register it in `./index.ts`. */
export interface Theme {
  /** Saved on this computer. Never shown. Use lowercase letters, digits and hyphens. */
  id: string;
  /** The name in the theme menu. */
  name: string;
  /** One plain sentence under the name. */
  blurb: string;
  mode: "light" | "dark";
  /** Body text. A face the app does not ship falls back to Inter. */
  font: string;
  /** Page titles and other large headings. Use `font` when the theme has one face. */
  displayFont: string;
  /** 640 for a sans title, 560 for a serif title. */
  displayWeight: number;
  /** Letter spacing on those large headings. */
  displayTrack: string;
  /** Letter spacing on body text. */
  bodyTrack: string;
  logoFrom: string;
  logoTo: string;
  /** Cards, menus and other small surfaces. */
  radius: string;
  radiusSm: string;
  /** Sheets, including the task workspace. */
  sheetRadius: string;
  /** Card padding. One to four CSS lengths. */
  cardPad: string;
  cardGap: string;
  /** Board padding. One to four CSS lengths. */
  boardPad: string;
  /** Space between board groups. */
  sectionGap: string;
  /** The task flow's ground. */
  canvas: string;
  /** A quiet dot on that ground, fainter than a step's outline. */
  canvasDot: string;
  canvasDotSize: string;
  /** Fill of a step that needs the person. Gold, softer than a highlight. */
  youFill: string;
  /** Corner of an agent's step on the flow. Capsules stay round. */
  nodeRadius: string;
  /** Lift under a flow step. Omit it for the shared light or dark shadow. */
  nodeShadow?: string;
  /** The dim layer behind a sheet. */
  scrim: string;
  /**
   * Surfaces, the accent, and the semantic colours.
   * Gold means needs you, blue means an agent is working, green means done, red means failed.
   * The accent is New task. Keep it off those four, and off the other accent hues.
   */
  colors: ThemeColors;
}

export interface ThemeColors {
  bg: string;
  surface: string;
  sunken: string;
  hover: string;
  held: string;
  selected: string;
  line: string;
  lineStrong: string;
  /** Outlines that must be seen, about 3:1 on the canvas. */
  field: string;
  focus: string;
  text: string;
  text2: string;
  /** Metadata. About 4.5:1 on bg and surface. */
  text3: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentText: string;
  /** Text on the accent button. About 4.5:1 on accent. */
  onAccent: string;
  suggest: string;
  suggestLine: string;
  lead: string;
  leadHover: string;
  onLead: string;
  amber: string;
  amberText: string;
  amberSoft: string;
  amberLine: string;
  green: string;
  greenText: string;
  greenSoft: string;
  red: string;
  redText: string;
  redSoft: string;
  blue: string;
  blueText: string;
  blueSoft: string;
  slate: string;
  badge: string;
  onBadge: string;
  shadowCard: string;
  shadowLift: string;
  shadowPop: string;
}
