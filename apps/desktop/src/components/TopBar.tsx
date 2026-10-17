// The bar across the top: product, search, the engine's connection, who is blocked on you, the pool,
// the inbox and New task. As the window narrows it gives up the wordmark and repeated wording, then the
// search field, the pool's squares, then pool and theme into More.

import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bell, Ellipsis, Hand, Moon, Plus, Search, Sun, X } from "lucide-react";
import type { State } from "@petrina/core";
import type { EngineStatus } from "../engine";
import { mod } from "../keyboard";
import type { Lookup } from "../lib";
import type { Theme } from "../theme";
import { Logo, useDismiss } from "./bits";
import { EnginePill } from "./EngineState";
import { PoolButton, PoolPanel } from "./Pool";
import { ProductSwitcher } from "./Products";
import type { SheetTab } from "./TaskCard";

/** What the top bar keeps at the window's width. */
export interface BarRoom {
  roomy: boolean;
  searchField: boolean;
  poolSquares: boolean;
  barExtras: boolean;
  inboxLabel: boolean;
}

interface TopBarProps {
  state: State;
  find: Lookup;
  status: EngineStatus;
  room: BarRoom;
  product: string;
  onProduct: (productId: string) => void;
  query: string;
  onClearQuery: () => void;
  onPalette: () => void;
  blocking: number;
  inboxOpen: boolean;
  inboxButton: RefObject<HTMLButtonElement | null>;
  onOpenInbox: () => void;
  onToggleInbox: () => void;
  onNewTask: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  /** Open the Analytics page (the pool's link to today's numbers). */
  onAnalytics: () => void;
}

export function TopBar({ state, find, status, room, product, onProduct, query, onClearQuery, onPalette, blocking, inboxOpen, inboxButton, onOpenInbox, onToggleInbox, onNewTask, theme, onTheme, onOpen, onAnalytics }: TopBarProps) {
  const { roomy, searchField, poolSquares, barExtras, inboxLabel } = room;
  const themeButton = (
    <button className="btn ghost icon" aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"} title="Switch theme" onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
  return (
    <header className="topbar">
      <div className="brand" aria-label="Petrina">
        <Logo />
        {roomy && "Petrina"}
      </div>
      <ProductSwitcher state={state} value={product} onChange={onProduct} />
      <div className="palette-launcher">
        <button className={searchField ? "search-field palette-trigger" : "btn ghost icon"} aria-label="Find tasks, products or actions" title={`Command palette (${mod}K)`} onClick={onPalette}>
          <Search size={18} aria-hidden="true" />
          {searchField && (
            <>
              <span>Find tasks or actions</span>
              <kbd>{mod}K</kbd>
            </>
          )}
        </button>
        {query && (
          <span className="active-filter">
            <span title={query}>{query}</span>
            <button aria-label="Clear the board filter" onClick={onClearQuery}>
              <X size={14} />
            </button>
          </span>
        )}
      </div>
      <div className="spacer" />
      {barExtras && <EnginePill status={status} compact={!roomy} />}
      {blocking > 0 && (
        <button className="blocking-pill" onClick={onOpenInbox} aria-label={`You're blocking ${blocking} agent${blocking === 1 ? "" : "s"}. Open the inbox`}>
          <Hand size={16} strokeWidth={2.2} aria-hidden="true" />
          {roomy ? (
            <span>
              You're blocking <span className="num">{blocking}</span> agent{blocking === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="num">{blocking}</span>
          )}
        </button>
      )}
      {barExtras && <PoolButton state={state} find={find} onOpen={onOpen} onAnalytics={onAnalytics} compact={!poolSquares} />}
      <button ref={inboxButton} className="btn quiet" onClick={onToggleInbox} aria-pressed={inboxOpen} aria-label={`Inbox, ${state.inbox.length} waiting on you`} title="Needs you (I)">
        <Bell size={16} aria-hidden="true" />
        {inboxLabel && "Inbox"}
        {state.inbox.length > 0 && <span className="count">{state.inbox.length}</span>}
      </button>
      <button className="btn primary" onClick={onNewTask} title={`New task (${mod}N)`}>
        <Plus size={16} aria-hidden="true" />
        New task
      </button>
      {barExtras ? themeButton : <MoreMenu state={state} find={find} onOpen={onOpen} onAnalytics={onAnalytics} status={status} themeButton={themeButton} />}
    </header>
  );
}

interface MoreProps {
  state: State;
  find: Lookup;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onAnalytics: () => void;
  status: EngineStatus;
  themeButton: ReactNode;
}

/** In the narrowest windows the pool, the theme and the connection status move here. */
function MoreMenu({ state, find, onOpen, onAnalytics, status, themeButton }: MoreProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  return (
    <div style={{ position: "relative" }} ref={box}>
      <button className="btn ghost icon" aria-label="More" aria-expanded={open} onClick={() => setOpen((on) => !on)}>
        <Ellipsis size={18} />
      </button>
      {open && (
        <div className="popover">
          <div className="more-section">
            <PoolPanel state={state} find={find} onOpen={onOpen} onDone={close} onAnalytics={onAnalytics} />
          </div>
          <div className="more-section row between">
            <EnginePill status={status} />
            <span className="row" style={{ gap: 8 }}>
              Theme
              {themeButton}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
