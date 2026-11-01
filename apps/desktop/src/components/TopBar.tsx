// The bar across the top: product, search, the engine's connection, who is blocked on you, the pool,
// the inbox and New task. As the window narrows it gives up the wordmark and repeated wording, then the
// search field, the pool's squares, then pool and theme into More.

import { useCallback, useRef, useState, type RefObject } from "react";
import { Bell, Ellipsis, Hand, Plus, Search, X } from "lucide-react";
import { countableInboxItems, type State } from "@petrina/core";
import type { EngineStatus } from "../engine";
import { GLOBAL_COMMANDS, shortcutTitle } from "../commands";
import { screenMark, type Lookup } from "../lib";
import type { Theme } from "../theme";
import { Logo, useDismiss } from "./bits";
import { EnginePill } from "./EngineState";
import { PoolButton, PoolPanel, ScreenMarkIcon } from "./Pool";
import { ProductSwitcher } from "./Products";
import type { SheetTab } from "./TaskCard";
import { ThemeChoices, ThemeMenu } from "./ThemeMenu";

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
  switcherOpen?: boolean;
  onSwitcherOpenChange?: (open: boolean) => void;
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

export function TopBar({ state, find, status, room, product, onProduct, switcherOpen, onSwitcherOpenChange, query, onClearQuery, onPalette, blocking, inboxOpen, inboxButton, onOpenInbox, onToggleInbox, onNewTask, theme, onTheme, onOpen, onAnalytics }: TopBarProps) {
  const { roomy, searchField, poolSquares, barExtras, inboxLabel } = room;
  return (
    <header className="topbar">
      <div className="brand" aria-label="Petrina">
        <Logo />
        {roomy && "Petrina"}
      </div>
      <ProductSwitcher
        state={state}
        value={product}
        onChange={onProduct}
        {...(switcherOpen !== undefined ? { open: switcherOpen } : {})}
        {...(onSwitcherOpenChange ? { onOpenChange: onSwitcherOpenChange } : {})}
      />
      <div className="palette-launcher">
        <button
          className={searchField ? "search-field palette-trigger" : "btn ghost icon"}
          aria-label="Find tasks, products or actions"
          title={shortcutTitle(GLOBAL_COMMANDS.palette.label, GLOBAL_COMMANDS.palette.shortcutDisplay)}
          onClick={onPalette}
        >
          <Search size={18} aria-hidden="true" />
          {searchField && (
            <>
              <span>Find tasks or actions</span>
              <kbd>{GLOBAL_COMMANDS.palette.shortcutDisplay}</kbd>
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
      <button
        ref={inboxButton}
        className="btn quiet"
        onClick={onToggleInbox}
        aria-pressed={inboxOpen}
        aria-label={`Inbox, ${countableInboxItems(state.inbox).length} waiting on you`}
        title={shortcutTitle(GLOBAL_COMMANDS.inbox.label, GLOBAL_COMMANDS.inbox.shortcutDisplay)}
      >
        <Bell size={16} aria-hidden="true" />
        {inboxLabel && "Inbox"}
        {countableInboxItems(state.inbox).length > 0 && <span className="count">{countableInboxItems(state.inbox).length}</span>}
      </button>
      <button
        className="btn primary"
        onClick={onNewTask}
        title={shortcutTitle(GLOBAL_COMMANDS["new-task"].label, GLOBAL_COMMANDS["new-task"].shortcutDisplay)}
      >
        <Plus size={16} aria-hidden="true" />
        New task
      </button>
      {barExtras ? <ThemeMenu
        theme={theme}
        onTheme={onTheme}
      /> : <MoreMenu
        state={state}
        find={find}
        onOpen={onOpen}
        onAnalytics={onAnalytics}
        status={status}
        theme={theme}
        onTheme={onTheme}
      />}
    </header>
  );
}

interface MoreProps {
  state: State;
  find: Lookup;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  onAnalytics: () => void;
  status: EngineStatus;
  theme: Theme;
  onTheme: (theme: Theme) => void;
}

/**
 * In the narrowest windows the pool, the theme and the connection status move here. The screen mark
 * moves with the pool, onto the More button, so screen use is never on unseen.
 */
function MoreMenu({ state, find, onOpen, onAnalytics, status, theme, onTheme }: MoreProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, open, close);
  const mark = screenMark(state);
  return (
    <div style={{ position: "relative" }} ref={box}>
      <button
        className={`btn ghost icon ${mark ? "with-mark" : ""}`}
        aria-label={mark ? `More. ${mark.label}` : "More"}
        title={mark?.label}
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
      >
        <ScreenMarkIcon state={state} />
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover">
          <div className="more-section">
            <PoolPanel state={state} find={find} onOpen={onOpen} onDone={close} onAnalytics={onAnalytics} />
          </div>
          <div className="more-section">
            <h4>Theme</h4>
            <ThemeChoices theme={theme} onTheme={onTheme} onPicked={close} idPrefix="theme-more" />
          </div>
          <div className="more-section">
            <EnginePill status={status} />
          </div>
        </div>
      )}
    </div>
  );
}
