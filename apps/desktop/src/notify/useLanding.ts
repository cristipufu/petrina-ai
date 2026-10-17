// Where a click on a notification (or View on an in-app message) lands: the inbox opens at its item,
// highlighted and focused, with its task card flashing on the board. Nothing typed is ever lost: while
// New task, Add product or a task sheet with something typed in it is open, the jump waits for it to close.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { KeyArea, State } from "@petrina/core";
import { dismissPopovers, hasTyping } from "../components/bits";
import type { Landing } from "../components/Inbox";
import { canLand, landingFor, planJump } from "./jump";
import { waitingLine, type Target } from "./words";

/** How long a task card stays highlighted after a notification's item opens. */
const FLASH_MS = 1800;

/** A jump waiting for the window that holds it to close. A later click replaces it. */
export interface Jump {
  target: Target;
  /** What is waiting, for the line at the top of the open window. */
  line: string;
  /** A task sheet holds it: something typed there is not sent yet. */
  sheet: boolean;
}

interface Windows {
  state: State;
  /** New task or Add product is open. */
  dialog: boolean;
  sheet: boolean;
}

interface Context {
  /** Read by notification clicks, which arrive outside React's renders. */
  latest: RefObject<Windows>;
  inboxPanel: RefObject<HTMLElement | null>;
  closeSheet: () => void;
  closeOverlays: () => void;
  openInboxAt: (owner: KeyArea, itemId: string | undefined) => void;
}

export function useLanding({ latest, inboxPanel, closeSheet, closeOverlays, openInboxAt }: Context) {
  const [jump, setJump] = useState<Jump>();
  const [landing, setLanding] = useState<Landing>();
  const landings = useRef(0);
  // A notification that names no item opened the inbox: focusing it highlights nothing.
  const blankLanding = useRef(false);

  /**
   * Open the inbox where a notification points: at its item, scrolled into view, highlighted and
   * focused, with its task card highlighted briefly on the board. An item already handled opens
   * the inbox with a short note; a summary, or a click the system did not trace, opens the inbox
   * with nothing selected. The page and the product filter stay as they are.
   */
  const land = useCallback(
    (target: Target) => {
      const { item, note } = landingFor(target, latest.current.state.inbox);
      openInboxAt("inbox", item?.id);
      blankLanding.current = !item;
      landings.current += 1;
      setLanding({ n: landings.current, ...(item ? { itemId: item.id } : {}), ...(note ? { note } : {}) });
      const card = item && document.querySelector<HTMLElement>(`.card[data-task-id="${CSS.escape(item.taskId)}"]`);
      if (card) {
        card.classList.remove("flash");
        void card.offsetWidth;
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), FLASH_MS);
      }
    },
    [latest, openInboxAt],
  );

  /** A click on a notification, or View on an in-app message. */
  const requestJump = useCallback(
    (target: Target) => {
      dismissPopovers();
      closeOverlays();
      const now = latest.current;
      const plan = planJump({ dialog: now.dialog, sheet: now.sheet, sheetTyped: hasTyping(document.querySelector(".sheet")) });
      if (plan.closeSheet) closeSheet();
      if (!plan.wait) {
        setJump(undefined);
        land(target);
        return;
      }
      const { item } = landingFor(target, now.state.inbox);
      const line = item ? waitingLine(item, now.state) : target.kind === "inbox" ? "Things in your inbox need you" : "Something you were notified about";
      setJump({ target, line, sheet: plan.sheetHolds });
    },
    [land, closeSheet, closeOverlays, latest],
  );

  // As soon as the window holding a jump closes, finished or cancelled, the inbox opens at it.
  const { dialog, sheet } = latest.current;
  useEffect(() => {
    if (!jump || !canLand({ dialog, sheet }, jump.sheet)) return;
    setJump(undefined);
    land(jump.target);
  }, [jump, dialog, sheet, land]);

  // Landing in the inbox: the item comes into view, highlighted and focused, or the inbox itself.
  useEffect(() => {
    if (!landing) return;
    const panel = inboxPanel.current;
    const row = landing.itemId ? Array.from(panel?.querySelectorAll<HTMLElement>("[data-inbox-id]") ?? []).find((node) => node.getAttribute("data-inbox-id") === landing.itemId) : undefined;
    if (!row) {
      panel?.focus();
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    row.focus({ preventScroll: true });
    const ask = row.querySelector<HTMLElement>(".ask") ?? row;
    ask.classList.remove("landed");
    void ask.offsetWidth;
    ask.classList.add("landed");
  }, [landing, inboxPanel]);

  return { jump, landing, requestJump, blankLanding };
}
