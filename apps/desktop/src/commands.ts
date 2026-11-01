import type { Page, Task } from "@petrina/core";
import { PAGE_CATALOG, pageShortcutDisplay, PALETTE_PAGE_ORDER, SINGLE_KEY_PAGES } from "./pageCatalog";

export const mac = /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : (navigator.platform ?? ""));
export const mod = mac ? "⌘" : "Ctrl+";
export const alt = mac ? "⌥" : "Alt+";

export function shortcutTitle(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

export type GlobalCommandId =
  | "palette"
  | "new-task"
  | "switch-product"
  | "settings"
  | "inbox"
  | "shortcuts";

export interface GlobalCommandDescriptor {
  readonly id: GlobalCommandId;
  readonly label: string;
  readonly paletteLabel?: string;
  readonly shortcutHelp: string;
  readonly key: string;
  readonly kind: "mod" | "single";
  readonly shortcutDisplay: string;
  /** Always call `event.preventDefault()` even when a blocking dialog is open (e.g. `⌘P` never triggers browser Print). */
  readonly preventBrowserDefaultAlways?: boolean;
  /** Run even while `CommandPalette` or `KeyboardShortcuts` is open (`⌘K` toggles the palette). */
  readonly activeInOverlays?: boolean;
  readonly ignoreRepeat?: boolean;
}

export const GLOBAL_COMMANDS: Readonly<Record<GlobalCommandId, GlobalCommandDescriptor>> = {
  palette: {
    id: "palette",
    label: "Command palette",
    shortcutHelp: "Open or close the command palette",
    key: "k",
    kind: "mod",
    shortcutDisplay: `${mod}K`,
    activeInOverlays: true,
  },
  "new-task": {
    id: "new-task",
    label: "New task",
    paletteLabel: "New task",
    shortcutHelp: "New task",
    key: "n",
    kind: "mod",
    shortcutDisplay: `${mod}N`,
  },
  "switch-product": {
    id: "switch-product",
    label: "Switch product",
    paletteLabel: "Switch product",
    shortcutHelp: "Switch product",
    key: "p",
    kind: "mod",
    shortcutDisplay: `${mod}P`,
    preventBrowserDefaultAlways: true,
  },
  settings: {
    id: "settings",
    label: PAGE_CATALOG.settings.label,
    paletteLabel: `Go to ${PAGE_CATALOG.settings.label}`,
    shortcutHelp: PAGE_CATALOG.settings.shortcutHelp ?? "Open Settings",
    key: ",",
    kind: "mod",
    shortcutDisplay: `${mod},`,
  },
  inbox: {
    id: "inbox",
    label: "Needs you",
    paletteLabel: "Open the inbox",
    shortcutHelp: "Enter the inbox; press again to hide it",
    key: "i",
    kind: "single",
    shortcutDisplay: "I",
    ignoreRepeat: true,
  },
  shortcuts: {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    paletteLabel: "Keyboard shortcuts",
    shortcutHelp: "Show keyboard shortcuts",
    key: "?",
    kind: "single",
    shortcutDisplay: "?",
    ignoreRepeat: true,
  },
};

export const canTogglePause = (task: Task): boolean =>
  !task.driving && ["queued", "paused", "running", "needs-you", "waiting"].includes(task.state);

export const canMessage = (task: Task): boolean => task.state !== "done" && task.state !== "cancelled";

export function pauseActionVerb(task: Pick<Task, "state" | "held">): "Release" | "Hold" | "Resume" | "Pause" {
  if (task.state === "queued") return task.held ? "Release" : "Hold";
  if (task.state === "paused") return "Resume";
  return "Pause";
}

export type TaskCommandId = "open" | "message" | "pause" | "move-top";

export interface TaskCommandDescriptor {
  readonly id: TaskCommandId;
  readonly shortcutDisplay: string;
  readonly singleKey?: string;
  readonly shortcutHelp?: string;
  readonly ignoreRepeat?: boolean;
  readonly enabled: (task: Task) => boolean;
  readonly paletteLabel: (task: Task) => string;
}

export const TASK_COMMANDS: Readonly<Record<TaskCommandId, TaskCommandDescriptor>> = {
  open: {
    id: "open",
    shortcutDisplay: "↵",
    enabled: () => true,
    paletteLabel: (task) => `Open “${task.title}”`,
  },
  pause: {
    id: "pause",
    shortcutDisplay: "P",
    singleKey: "p",
    shortcutHelp: "Pause or resume; hold or release a queued task",
    ignoreRepeat: true,
    enabled: canTogglePause,
    paletteLabel: (task) => `${pauseActionVerb(task)} “${task.title}”`,
  },
  message: {
    id: "message",
    shortcutDisplay: "M",
    singleKey: "m",
    shortcutHelp: "Message the task in focus",
    ignoreRepeat: true,
    enabled: canMessage,
    paletteLabel: (task) => `Message “${task.title}”`,
  },
  "move-top": {
    id: "move-top",
    shortcutDisplay: "↵",
    enabled: (task) => task.state === "queued",
    paletteLabel: (task) => `Move “${task.title}” to top`,
  },
};

const PAGE_SINGLE_SHORTCUTS: readonly [string, string][] = PALETTE_PAGE_ORDER.flatMap((page) => {
  const entry = PAGE_CATALOG[page];
  if (entry.shortcut?.kind !== "single" || !entry.shortcutHelp) return [];
  const display = pageShortcutDisplay(page, mod);
  return display ? [[display, entry.shortcutHelp] as [string, string]] : [];
});

/** Single source of truth for the Keyboard shortcuts dialog (`?`). */
export const SHORTCUTS: [string, string][] = [
  [GLOBAL_COMMANDS.palette.shortcutDisplay, GLOBAL_COMMANDS.palette.shortcutHelp],
  [GLOBAL_COMMANDS["new-task"].shortcutDisplay, GLOBAL_COMMANDS["new-task"].shortcutHelp],
  [GLOBAL_COMMANDS["switch-product"].shortcutDisplay, GLOBAL_COMMANDS["switch-product"].shortcutHelp],
  [GLOBAL_COMMANDS.settings.shortcutDisplay, GLOBAL_COMMANDS.settings.shortcutHelp],
  ["J / K", "Next or previous card or inbox item"],
  ["Enter", "Open the highlighted card or inbox item"],
  [`${alt}↑ / ${alt}↓`, "Move a queued card one visible place"],
  [TASK_COMMANDS.pause.shortcutDisplay, TASK_COMMANDS.pause.shortcutHelp!],
  [TASK_COMMANDS.message.shortcutDisplay, TASK_COMMANDS.message.shortcutHelp!],
  [GLOBAL_COMMANDS.inbox.shortcutDisplay, GLOBAL_COMMANDS.inbox.shortcutHelp],
  ...PAGE_SINGLE_SHORTCUTS,
  [GLOBAL_COMMANDS.shortcuts.shortcutDisplay, GLOBAL_COMMANDS.shortcuts.shortcutHelp],
  ["Esc", "Close the top layer; leave a text box without losing its text"],
  ["Tab / Shift+Tab", "Move between buttons and fields"],
];

export function matchSingleKeyPage(key: string): Page | undefined {
  return SINGLE_KEY_PAGES[key];
}
