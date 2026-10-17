// What a click on a notification does, given what is open. Nothing typed is ever lost: New task
// and Add product stay open, and so does a task sheet with something typed and not sent; the
// inbox opens at the item as soon as that window closes. A task sheet with nothing typed closes
// at once. Petrina never guesses: anything it cannot trace to a waiting item opens the inbox only.

import type { InboxItem } from "@petrina/core";
import type { Target } from "./words";

export interface OpenWindows {
  /** New task or Add product. */
  dialog: boolean;
  /** A task sheet. */
  sheet: boolean;
  /** Something typed in the task sheet and not sent: a message, an answer, a note. */
  sheetTyped: boolean;
}

export interface JumpPlan {
  /** Close the task sheet first: nothing typed in it. */
  closeSheet: boolean;
  /** The task sheet holds the jump until it closes. */
  sheetHolds: boolean;
  /** Land now, or wait for the open window to close. */
  wait: boolean;
}

export function planJump(open: OpenWindows): JumpPlan {
  const sheetHolds = open.sheet && open.sheetTyped;
  return { closeSheet: open.sheet && !open.sheetTyped, sheetHolds, wait: open.dialog || sheetHolds };
}

/** A waiting jump lands once its window is closed: the dialog, and the sheet if it held it. */
export function canLand(open: Pick<OpenWindows, "dialog" | "sheet">, sheetHolds: boolean): boolean {
  return !open.dialog && !(sheetHolds && open.sheet);
}

export const ALREADY_HANDLED = "Already handled. Nothing else changed.";

/** Where the inbox lands: at the item while it waits, else at the top, with a note when it was handled. */
export function landingFor(target: Target, inbox: readonly InboxItem[]): { item?: InboxItem; note?: string } {
  if (target.kind !== "item") return {};
  const item = inbox.find((entry) => entry.id === target.id);
  return item ? { item } : { note: ALREADY_HANDLED };
}
