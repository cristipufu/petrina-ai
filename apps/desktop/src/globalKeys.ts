// The window's keyboard: the palette (⌘K), New task (⌘N), Settings (⌘,), Escape, Enter, Alt+arrows to move
// a queued task, and the single-key shortcuts (I, B, A, L, ?, J/K, P, M) when they are on.

import { useEffect } from "react";
import type { keyArea, Page, Task } from "@petrina/core";
import { isTyping } from "./keyboard";

export interface GlobalKeys {
  /** A window with keys of its own is open: the palette, New task, Add product or the shortcut list. */
  palette: boolean;
  modal: boolean;
  sheetOpen: boolean;
  /** Where the keyboard is: the board, the inbox, an open task, or nowhere in particular. */
  area: ReturnType<typeof keyArea>;
  singleKeys: boolean;
  focusedTask: Task | undefined;
  boardId: string | undefined;
  inboxId: string | undefined;
  togglePalette: () => void;
  closeSheet: () => void;
  leaveInbox: () => void;
  newTask: () => void;
  openSettings: () => void;
  move: (task: Task, direction: -1 | 1) => void;
  openBoard: (id: string) => void;
  openItem: (id: string) => void;
  inboxKey: () => void;
  go: (page: Page) => void;
  showShortcuts: () => void;
  walk: (direction: -1 | 1) => void;
  pause: (task: Task) => void;
  message: (task: Task) => void;
}

/** Listens for the whole window, before anything else, so Escape has one owner. Read afresh on every render. */
export function useGlobalKeys(keys: GlobalKeys): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement;
      const key = event.key.toLocaleLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault(); event.stopImmediatePropagation();
        keys.togglePalette();
        return;
      }
      if (keys.palette || keys.modal) return;
      // Popovers handle their own keys. A task sheet is the one dialog with navigation keys.
      if (target.closest("[role=dialog]:not(.sheet), [role=menu], .popover, .menu") || document.querySelector(".popover, .menu")) return;
      // Inline product editors discard their draft (or close removal confirmation) themselves.
      if (event.key === "Escape" && target.closest(".product-editor")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (isTyping(target)) target.blur();
        else if (keys.sheetOpen) keys.closeSheet();
        else if (keys.area === "inbox") keys.leaveInbox();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "n") { event.preventDefault(); keys.newTask(); return; }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") { event.preventDefault(); keys.openSettings(); return; }
      if (isTyping(target) || event.metaKey || event.ctrlKey) return;
      if (event.altKey && (key === "arrowup" || key === "arrowdown")) {
        if (keys.focusedTask) { event.preventDefault(); keys.move(keys.focusedTask, key === "arrowup" ? -1 : 1); } return;
      }
      if (key === "enter" && !target.closest("button, a, [role=button], [role=radio]")) {
        if (keys.area === "board" && keys.boardId) { event.preventDefault(); keys.openBoard(keys.boardId); }
        else if (keys.area === "inbox" && keys.inboxId) { event.preventDefault(); keys.openItem(keys.inboxId); }
        return;
      }
      if (event.altKey || !keys.singleKeys) return;
      if (event.repeat && ["p", "i", "m", "?"].includes(key)) return;
      if (key === "i") { event.preventDefault(); keys.inboxKey(); }
      else if (key === "b" || key === "a" || key === "l") { event.preventDefault(); keys.go(key === "b" ? "board" : key === "a" ? "agents" : "library"); }
      else if (key === "?") { event.preventDefault(); keys.showShortcuts(); }
      else if ((key === "j" || key === "k") && keys.area) { event.preventDefault(); keys.walk(key === "j" ? 1 : -1); }
      else if (key === "p" && keys.focusedTask) { event.preventDefault(); keys.pause(keys.focusedTask); }
      else if (key === "m" && keys.focusedTask) { event.preventDefault(); keys.message(keys.focusedTask); }
    };
    // Capture gives Escape one owner before nested dialogs or text controls see it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
}
