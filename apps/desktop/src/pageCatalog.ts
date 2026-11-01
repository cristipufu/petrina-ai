import { PAGES, type Page } from "@petrina/core";

export type RailSection = "work" | "configuration" | "footer";

export interface PageShortcut {
  readonly key: string;
  readonly kind: "single" | "mod";
}

export interface PageDescriptor {
  readonly id: Page;
  readonly label: string;
  readonly railSection: RailSection;
  readonly shortcut?: PageShortcut;
  /** Description shown in the Keyboard shortcuts dialog when `shortcut` is present. */
  readonly shortcutHelp?: string;
  readonly showBlockingBadge?: boolean;
  /** Whether navigating directly to this page focuses the board/history list. */
  readonly focusBoardOnEnter: boolean;
  /** Whether switching products stays on this page instead of returning to Board. */
  readonly preservesViewOnProductSwitch: boolean;
}

export const PAGE_CATALOG: Readonly<Record<Page, PageDescriptor>> = {
  board: {
    id: "board",
    label: "Board",
    railSection: "work",
    shortcut: { key: "b", kind: "single" },
    shortcutHelp: "Return to the board",
    focusBoardOnEnter: true,
    preservesViewOnProductSwitch: false,
  },
  history: {
    id: "history",
    label: "History",
    railSection: "work",
    focusBoardOnEnter: true,
    preservesViewOnProductSwitch: true,
  },
  agents: {
    id: "agents",
    label: "Agents",
    railSection: "work",
    shortcut: { key: "a", kind: "single" },
    shortcutHelp: "Open Agents",
    showBlockingBadge: true,
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: false,
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    railSection: "work",
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: true,
  },
  products: {
    id: "products",
    label: "Products",
    railSection: "configuration",
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: false,
  },
  routines: {
    id: "routines",
    label: "Routines",
    railSection: "configuration",
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: true,
  },
  library: {
    id: "library",
    label: "Library",
    railSection: "configuration",
    shortcut: { key: "l", kind: "single" },
    shortcutHelp: "Open Library",
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: false,
  },
  settings: {
    id: "settings",
    label: "Settings",
    railSection: "footer",
    shortcut: { key: ",", kind: "mod" },
    shortcutHelp: "Open Settings",
    focusBoardOnEnter: false,
    preservesViewOnProductSwitch: false,
  },
};

export const PAGE_NAMES: Record<Page, string> = Object.fromEntries(
  PAGES.map((page) => [page, PAGE_CATALOG[page].label]),
) as Record<Page, string>;

export const RAIL_GROUPS: readonly {
  readonly section: Exclude<RailSection, "footer">;
  readonly label: string;
  readonly pages: readonly Page[];
}[] = [
  {
    section: "work",
    label: "Work",
    pages: PAGES.filter((page) => PAGE_CATALOG[page].railSection === "work"),
  },
  {
    section: "configuration",
    label: "Products and configuration",
    pages: PAGES.filter((page) => PAGE_CATALOG[page].railSection === "configuration"),
  },
];

export const PALETTE_PAGE_ORDER: readonly Page[] = [
  ...RAIL_GROUPS.flatMap((group) => group.pages),
  ...PAGES.filter((page) => PAGE_CATALOG[page].railSection === "footer"),
];

export const SINGLE_KEY_PAGES: Readonly<Record<string, Page>> = Object.fromEntries(
  PAGES.flatMap((page) => {
    const shortcut = PAGE_CATALOG[page].shortcut;
    return shortcut?.kind === "single" ? [[shortcut.key, page] as const] : [];
  }),
);

export function pageShortcutDisplay(page: Page, modSymbol: string): string | undefined {
  const shortcut = PAGE_CATALOG[page].shortcut;
  if (!shortcut) return undefined;
  return shortcut.kind === "mod" ? `${modSymbol}${shortcut.key.toUpperCase()}` : shortcut.key.toUpperCase();
}

export function pageRailTitle(page: Page, modSymbol: string): string {
  const { label } = PAGE_CATALOG[page];
  const display = pageShortcutDisplay(page, modSymbol);
  return display ? `${label} (${display})` : label;
}
