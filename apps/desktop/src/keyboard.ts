import { useSyncExternalStore } from "react";

export { alt, mac, mod, SHORTCUTS } from "./commands";

const STORAGE_KEY = "petrina.single-key-shortcuts";
const listeners = new Set<() => void>();
function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
let enabled = readPreference();
export function setSingleKeys(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  } catch {
    /* Still works for this window. */
  }
  listeners.forEach((listener) => listener());
}
export function useSingleKeys(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => enabled,
  );
}

export function isTyping(target: HTMLElement): boolean {
  return Boolean(
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox], [role=listbox]"),
  );
}
