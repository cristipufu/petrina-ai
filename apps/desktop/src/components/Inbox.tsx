import { forwardRef, useEffect, useState } from "react";
import { BellRing, PanelRightClose, PartyPopper } from "lucide-react";
import { inboxOrder, inboxSummary, type State } from "@petrina/core";
import { desktop, useEngineStatus, useUnsent } from "../engine";
import { type Lookup } from "../lib";
import { useBrowserPermission } from "../notify/channels";
import { finishOffer, useNotifySettings } from "../notify/settings";
import { realSquad, turnOnInBrowser } from "../notify/useNotices";
import { UnsentNote } from "./EngineState";
import { Ask } from "./InboxAsk";
import type { SheetTab } from "./TaskCard";

export { Ask } from "./InboxAsk";

/** Where the inbox opens after a click on a notification: at an item, or at its top with a note. */
export interface Landing {
  /** Counts up, so the same item can be landed on twice. */
  n: number;
  itemId?: string;
  note?: string;
}

interface InboxProps {
  state: State;
  find: Lookup;
  /** Over the board, in narrow windows. */
  overlay: boolean;
  landing?: Landing | undefined;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onClose: () => void;
  selectedId: string | undefined;
  onFocus: (id?: string) => void;
  onOpenItem: (itemId: string, tab?: SheetTab) => void;
}

/** How long "Already handled" stays. */
const NOTE_MS = 6000;

export const Inbox = forwardRef<HTMLElement, InboxProps>(function Inbox(
  { state, find, overlay, landing, onOpenItem, onClose, selectedId, onFocus },
  ref,
) {
  const items = inboxOrder(state);
  const connected = useEngineStatus().link === "live";
  // Answers whose question is gone (a restart dropped it): still shown until the engine has them.
  const orphans = useUnsent().filter((entry) => entry.itemId && !state.inbox.some((item) => item.id === entry.itemId));
  const [note, setNote] = useState<string>();

  useEffect(() => {
    setNote(landing?.note);
    if (!landing?.note) return;
    const timer = setTimeout(() => setNote(undefined), NOTE_MS);
    return () => clearTimeout(timer);
  }, [landing?.n, landing?.note]);

  return (
    <aside
      ref={ref}
      className={`inbox ${overlay ? "overlay" : ""}`}
      aria-label="Needs you"
      tabIndex={-1}
      onFocus={(event) => {
        if (!(event.target as HTMLElement).closest("[data-inbox-id]")) onFocus();
      }}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("[data-inbox-id]")) onFocus();
      }}
    >
      <div className="inbox-head">
        <h2>
          Needs you <span className="n">{items.length}</span>
        </h2>
        <button className="btn ghost icon" aria-label="Hide the inbox" title="Hide the inbox (I)" onClick={onClose}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <p className="inbox-sub num">{inboxSummary(items)}</p>
      {note && (
        <p className="inbox-note" role="status">
          {note}
        </p>
      )}
      <div className="inbox-list">
        <NotifyOffer />
        {orphans.length > 0 && (
          <div className="unsent-list" aria-label="Not sent yet">
            {orphans.map((entry) => (
              <UnsentNote key={entry.clientId} entry={entry} live={connected} />
            ))}
          </div>
        )}
        {items.length === 0 && (
          <div className="inbox-empty">
            <span className="big">
              <PartyPopper size={22} />
            </span>
            <div>All clear. The squad will ask when it needs you.</div>
          </div>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            data-inbox-id={item.id}
            tabIndex={-1}
            className={`inbox-item ${selectedId === item.id ? "selected" : ""}`}
            onFocus={() => onFocus(item.id)}
            onMouseDown={() => onFocus(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget) {
                event.preventDefault();
                onOpenItem(item.id);
              }
            }}
          >
            <Ask item={item} state={state} find={find} onOpen={(_taskId, tab) => onOpenItem(item.id, tab)} />
          </div>
        ))}
      </div>
    </aside>
  );
});

/**
 * In a browser tab on the real squad, once: an offer to turn on browser notifications. Gone for
 * good once answered or dismissed, or once they are turned on in Settings. Never in the desktop
 * app, where they are on by default.
 */
function NotifyOffer() {
  const settings = useNotifySettings();
  const permission = useBrowserPermission();
  if (
    desktop
    || !realSquad
    || settings.offerDone
    || settings.on
    || permission === "unsupported"
    || permission === "denied"
  ) {
    return null;
  }
  return (
    <section className="offer" aria-labelledby="notify-offer-title">
      <div className="offer-head">
        <BellRing size={16} aria-hidden="true" />
        <h3 id="notify-offer-title">Get notified in this browser?</h3>
      </div>
      <p>
        Petrina can tell you when the squad needs you while this tab is in the background. Your browser asks first.
      </p>
      <div className="ask-actions">
        <button
          className="btn lead small"
          onClick={() => {
            void turnOnInBrowser().finally(finishOffer);
          }}
        >
          Turn on notifications
        </button>
        <button className="btn quiet small" onClick={finishOffer}>
          Not now
        </button>
      </div>
    </section>
  );
}
