// The window's keyboard: the palette (⌘K), New task (⌘N), Switch product (⌘P), Settings (⌘,), Escape, Enter,
// Alt+arrows to move a queued task, and the single-key shortcuts (I, B, A, L, ?, J/K, P, M) when they are on.

import { useEffect } from "react";
import type { keyArea, Page, Task } from "@petrina/core";
import { GLOBAL_COMMANDS, matchSingleKeyPage, TASK_COMMANDS } from "./commands";
import { isTyping } from "./keyboard";

export interface GlobalKeys {
  /** A window with keys of its own is open: the palette, New task, Add product or the shortcut list. */
  palette: boolean;
  modal: boolean;
  popover: boolean;
  sheetOpen: boolean;
  /** Where the keyboard is: the board, the inbox, an open task, or nowhere in particular. */
  area: ReturnType<typeof keyArea>;
  singleKeys: boolean;
  focusedTask: Task | undefined;
  boardId: string | undefined;
  inboxId: string | undefined;
  togglePalette: () => void;
  switchProduct: () => void;
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
      const modPressed = event.metaKey || event.ctrlKey;
      if (modPressed && key === GLOBAL_COMMANDS.palette.key) {
        event.preventDefault();
        event.stopImmediatePropagation();
        keys.togglePalette();
        return;
      }
      if (modPressed && !event.altKey && !event.shiftKey && key === GLOBAL_COMMANDS["switch-product"].key) {
        // Never the browser's Print. Like ⌘K it works over an open task, but not over another dialog or popover.
        event.preventDefault();
        if (!keys.palette && !keys.modal && !keys.popover) keys.switchProduct();
        return;
      }
      if (keys.palette || keys.modal || keys.popover) return;
      // Usage history owns inspection keys and returning from its focused readings.
      const inspectingHistory =
        target.closest(".limit-history-plot")
        && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "Escape"].includes(event.key)
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey;
      const leavingReadings = event.key === "Escape" && target.closest(".limit-history-readings-view");
      if (!keys.sheetOpen && (inspectingHistory || leavingReadings)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isTyping(target)) target.blur();
        else if (keys.sheetOpen) keys.closeSheet();
        else if (keys.area === "inbox") keys.leaveInbox();
        return;
      }
      if (modPressed && key === GLOBAL_COMMANDS["new-task"].key) {
        event.preventDefault();
        keys.newTask();
        return;
      }
      if (modPressed && !event.altKey && !event.shiftKey && event.key === GLOBAL_COMMANDS.settings.key) {
        event.preventDefault();
        keys.openSettings();
        return;
      }
      if (isTyping(target) || modPressed) return;
      if (event.altKey && (key === "arrowup" || key === "arrowdown")) {
        if (keys.focusedTask) {
          event.preventDefault();
          keys.move(keys.focusedTask, key === "arrowup" ? -1 : 1);
        }
        return;
      }
      if (key === "enter" && !target.closest("button, a, [role=button], [role=radio]")) {
        if (keys.area === "board" && keys.boardId) {
          event.preventDefault();
          keys.openBoard(keys.boardId);
        } else if (keys.area === "inbox" && keys.inboxId) {
          event.preventDefault();
          keys.openItem(keys.inboxId);
        }
        return;
      }
      if (event.altKey || !keys.singleKeys) return;
      const page = matchSingleKeyPage(key);
      if (key === GLOBAL_COMMANDS.inbox.key) {
        if (event.repeat && GLOBAL_COMMANDS.inbox.ignoreRepeat) return;
        event.preventDefault();
        keys.inboxKey();
      } else if (page) {
        event.preventDefault();
        keys.go(page);
      } else if (key === GLOBAL_COMMANDS.shortcuts.key) {
        if (event.repeat && GLOBAL_COMMANDS.shortcuts.ignoreRepeat) return;
        event.preventDefault();
        keys.showShortcuts();
      } else if ((key === "j" || key === "k") && keys.area) {
        event.preventDefault();
        keys.walk(key === "j" ? 1 : -1);
      } else if (key === TASK_COMMANDS.pause.singleKey && keys.focusedTask) {
        if (event.repeat && TASK_COMMANDS.pause.ignoreRepeat) return;
        event.preventDefault();
        keys.pause(keys.focusedTask);
      } else if (key === TASK_COMMANDS.message.singleKey && keys.focusedTask) {
        if (event.repeat && TASK_COMMANDS.message.ignoreRepeat) return;
        event.preventDefault();
        keys.message(keys.focusedTask);
      }
    };
    // Capture gives Escape one owner before nested dialogs or text controls see it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
}
