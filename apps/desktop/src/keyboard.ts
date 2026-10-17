import { useSyncExternalStore } from "react";

const STORAGE_KEY = "petrina.single-key-shortcuts";
const listeners = new Set<() => void>();
function readPreference(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
}
let enabled = readPreference();
export function setSingleKeys(value: boolean): void {
  enabled = value;
  try { localStorage.setItem(STORAGE_KEY, value ? "on" : "off"); } catch { /* Still works for this window. */ }
  listeners.forEach((listener) => listener());
}
export function useSingleKeys(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => enabled);
}

export const mac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = mac ? "⌘" : "Ctrl+";
export const alt = mac ? "⌥" : "Alt+";

export function isTyping(target: HTMLElement): boolean {
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox], [role=listbox]"));
}

export const SHORTCUTS = [
  [`${mod}K`, "Open or close the command palette"],
  [`${mod}N`, "New task"],
  [`${mod}P`, "Switch product"],
  ["J / K", "Next or previous card or inbox item"],
  ["Enter", "Open the highlighted card or inbox item"],
  [`${alt}↑ / ${alt}↓`, "Move a queued card one visible place"],
  ["P", "Pause or resume; hold or release a queued task"],
  ["M", "Message the task in focus"],
  ["I", "Enter the inbox; press again to hide it"],
  ["B", "Return to the board"],
  ["A", "Open Agents"],
  ["L", "Open Library"],
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close the top layer; leave a text box without losing its text"],
  ["Tab / Shift+Tab", "Move between buttons and fields"],
];
