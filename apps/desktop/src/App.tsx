import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bell, Boxes, Bot, Ellipsis, Hand, LayoutGrid, Library, Moon, Plus, Search, Settings, Sun, X } from "lucide-react";
import type { State, Task } from "@petrina/core";
import { mode, startClock, useEngineStatus, useSim, type EngineStatus } from "./engine";
import { AddProductDialog } from "./components/AddProduct";
import { CouldNotStart, EnginePill, EngineRecovery, StartingScreen } from "./components/EngineState";
import { blockingCount, lookup, type Lookup } from "./lib";
import { dismissPopovers, hasTyping, Logo, useDismiss, useViewport, viewportSize } from "./components/bits";
import { Board } from "./components/Board";
import { Inbox, type Landing } from "./components/Inbox";
import { NewTaskDialog } from "./components/NewTask";
import { AgentsPage, LibraryPage } from "./components/Pages";
import { PoolButton, PoolPanel } from "./components/Pool";
import { ProductsPage, ProductSwitcher } from "./components/Products";
import { SettingsPage } from "./components/Settings";
import type { SheetTab } from "./components/TaskCard";
import { TaskSheet } from "./components/TaskSheet";
import { platform } from "./notify/channels";
import { canLand, landingFor, planJump } from "./notify/jump";
import { useNotices } from "./notify/useNotices";
import { waitingLine, type Notice, type Target } from "./notify/words";
import { applyTheme, initialTheme, type Theme } from "./theme";

type View = "board" | "products" | "agents" | "library" | "settings";

interface Toast {
  id: number;
  title: string;
  lines: readonly string[];
  /** What View opens: an inbox item, like a click on its notification. */
  target?: Target;
}

/**
 * A click on a notification, or View on an in-app message, while New task, Add product, or a task
 * sheet with something typed in it is open. It waits for that window to close, so nothing typed
 * is lost; a later click replaces it.
 */
interface Jump {
  target: Target;
  /** What is waiting, for the line at the top of the open window. */
  line: string;
  /** A task sheet holds it: something typed there is not sent yet. */
  sheet: boolean;
}

/** How long a task card stays highlighted after a notification's item opens. */
const FLASH_MS = 1800;
const SETTINGS_KEY = platform() === "mac" ? "⌘," : "Ctrl+,";

/** Below this width the inbox opens over the board instead of beside it. */
const DOCKED_INBOX = 1200;

export function App() {
  const state = useSim();
  const status = useEngineStatus();
  const find = useMemo(() => lookup(state), [state]);
  const viewport = useViewport();
  const [view, setView] = useState<View>("board");
  const [product, setProduct] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(() => viewportSize().width >= DOCKED_INBOX);
  const [sheet, setSheet] = useState<{ taskId: string; tab: SheetTab }>();
  const [creating, setCreating] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  // The product open in Settings' Products section.
  const [productSettings, setProductSettings] = useState<string>();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jump, setJump] = useState<Jump>();
  const [landing, setLanding] = useState<Landing>();
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const toastId = useRef(0);
  const landings = useRef(0);
  // Read by notification clicks, which arrive outside React's renders.
  const latest = useRef({ state, creating, addingProduct, sheet });
  latest.current = { state, creating, addingProduct, sheet };

  // What the top bar gives up as the window narrows (or zooms, or text grows), in this order: the
  // wordmark and repeated wording, then the search field, the pool's squares, then pool and theme
  // into More.
  const width = viewport.width;
  const roomy = width >= 1320;
  const searchField = width >= DOCKED_INBOX;
  const overlay = width < DOCKED_INBOX;
  const poolSquares = width >= 960;
  const barExtras = width >= 800;
  const inboxLabel = width >= 640;

  useEffect(() => startClock(), []);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (product !== "all" && !state.products.some((entry) => entry.id === product)) setProduct("all");
  }, [state.products, product]);

  const toast = useCallback((title: string, lines: readonly string[] = [], target?: Target) => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-2), { id, title, lines, ...(target ? { target } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), 6000);
  }, []);

  /**
   * Open the inbox where a notification points: at its item, scrolled into view, highlighted and
   * focused, with its task card highlighted briefly on the board. An item already handled opens
   * the inbox with a short note; a summary, or a click the system did not trace, opens the inbox
   * with nothing selected. The page and the product filter stay as they are.
   */
  const land = useCallback((target: Target) => {
    const { item, note } = landingFor(target, latest.current.state.inbox);
    setInboxOpen(true);
    landings.current += 1;
    setLanding({ n: landings.current, ...(item ? { itemId: item.id } : {}), ...(note ? { note } : {}) });
    const card = item && document.querySelector<HTMLElement>(`.card[data-task-id="${CSS.escape(item.taskId)}"]`);
    if (card) {
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), FLASH_MS);
    }
  }, []);

  /** A click on a notification, or View on an in-app message. Nothing typed is ever lost. */
  const requestJump = useCallback(
    (target: Target) => {
      dismissPopovers();
      const now = latest.current;
      const plan = planJump({ dialog: now.creating || now.addingProduct, sheet: now.sheet !== undefined, sheetTyped: hasTyping(document.querySelector(".sheet")) });
      if (plan.closeSheet) setSheet(undefined);
      if (!plan.wait) {
        setJump(undefined);
        land(target);
        return;
      }
      const { item } = landingFor(target, now.state.inbox);
      const line = item ? waitingLine(item, now.state) : target.kind === "inbox" ? "Things in your inbox need you" : "Something you were notified about";
      setJump({ target, line, sheet: plan.sheetHolds });
    },
    [land],
  );

  // As soon as the window holding a jump closes, finished or cancelled, the inbox opens at it.
  useEffect(() => {
    if (!jump || !canLand({ dialog: creating || addingProduct, sheet: sheet !== undefined }, jump.sheet)) return;
    setJump(undefined);
    land(jump.target);
  }, [jump, creating, addingProduct, sheet, land]);

  const toastNotice = useCallback((notice: Notice) => toast(notice.title, notice.lines, notice.target), [toast]);
  useNotices({ onJump: requestJump, onToast: toastNotice });

  const open = useCallback((taskId: string, tab: SheetTab = "overview") => {
    setSheet({ taskId, tab });
    if (viewportSize().width < DOCKED_INBOX) setInboxOpen(false);
  }, []);
  const close = useCallback(() => setSheet(undefined), []);

  /** Settings, with one product's settings open when it comes from the Products page. */
  const openSettings = useCallback((productId?: string) => {
    setProductSettings(productId);
    setView("settings");
  }, []);

  const openInbox = useCallback(() => setInboxOpen(true), []);
  // Closing the inbox hands focus back to the button that opens it.
  const closeInbox = useCallback(() => {
    setInboxOpen(false);
    inboxButton.current?.focus();
  }, []);

  // Over the board, the inbox takes focus when it opens (unless a notification's item already has it).
  useEffect(() => {
    if (inboxOpen && overlay && !inboxPanel.current?.contains(document.activeElement)) inboxPanel.current?.focus();
  }, [inboxOpen, overlay]);

  // Landing in the inbox: the item comes into view, highlighted and focused, or the inbox itself.
  useEffect(() => {
    if (!landing) return;
    const panel = inboxPanel.current;
    const article = landing.itemId ? panel?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(landing.itemId)}"]`) : undefined;
    if (!article) {
      panel?.focus();
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    article.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    article.focus({ preventScroll: true });
    article.classList.remove("landed");
    void article.offsetWidth;
    article.classList.add("landed");
  }, [landing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[aria-modal="true"]')) return;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCreating(true);
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
        searchRef.current?.focus();
      } else if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "i") {
          if (inboxPanel.current) closeInbox();
          else openInbox();
        }
        if (event.key === "b") setView("board");
        if (event.key === "p") setView("products");
        if (event.key === "a") setView("agents");
        if (event.key === "l") setView("library");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openInbox, closeInbox, openSettings]);

  const visible = useCallback(
    (task: Task) => (product === "all" || task.productId === product) && (!query.trim() || task.title.toLowerCase().includes(query.trim().toLowerCase())),
    [product, query],
  );

  const sheetTask = sheet ? find.task(sheet.taskId) : undefined;
  const blocking = blockingCount(state);
  const themeButton = (
    <button className="btn ghost icon" aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"} title="Switch theme" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
  const docked = inboxOpen && !overlay;
  const recovery = mode === "engine" && !status.desktop && status.link !== "live" && status.recovery;

  return (
    <div className={`app ${recovery ? "with-engine-hint" : ""}`} style={{ gridTemplateColumns: `var(--rail) minmax(0, 1fr) ${docked ? "auto" : "0px"}` }}>
      <header className="topbar">
        <div className="brand" aria-label="Petrina">
          <Logo />
          {roomy && "Petrina"}
        </div>
        <ProductSwitcher state={state} value={product} onChange={setProduct} />
        {searchField ? (
          <SearchField query={query} setQuery={setQuery} inputRef={searchRef} />
        ) : (
          <SearchButton query={query} setQuery={setQuery} inputRef={searchRef} open={searching} setOpen={setSearching} />
        )}
        <div className="spacer" />
        {barExtras && <EnginePill status={status} compact={!roomy} />}
        {blocking > 0 && (
          <button className="blocking-pill" onClick={openInbox} aria-label={`You're blocking ${blocking} agent${blocking === 1 ? "" : "s"}. Open the inbox`}>
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
        {barExtras && <PoolButton state={state} find={find} onOpen={open} compact={!poolSquares} />}
        <button
          ref={inboxButton}
          className="btn quiet"
          onClick={() => (inboxOpen ? closeInbox() : openInbox())}
          aria-pressed={inboxOpen}
          aria-label={`Inbox, ${state.inbox.length} waiting on you`}
          title="Needs you (I)"
        >
          <Bell size={16} aria-hidden="true" />
          {inboxLabel && "Inbox"}
          {state.inbox.length > 0 && <span className="count">{state.inbox.length}</span>}
        </button>
        <button className="btn primary" onClick={() => setCreating(true)} title="New task (⌘N)">
          <Plus size={16} aria-hidden="true" />
          New task
        </button>
        {barExtras ? themeButton : <MoreMenu state={state} find={find} onOpen={open} status={status} themeButton={themeButton} />}
      </header>
      {recovery && <EngineRecovery status={status} />}

      <nav className="rail" aria-label="Sections">
        <button className={view === "board" ? "on" : ""} aria-current={view === "board" ? "page" : undefined} onClick={() => setView("board")} title="Board (B)">
          <LayoutGrid size={20} aria-hidden="true" />
          Board
        </button>
        <button className={view === "products" ? "on" : ""} aria-current={view === "products" ? "page" : undefined} onClick={() => setView("products")} title="Products (P)">
          <Boxes size={20} aria-hidden="true" />
          Products
        </button>
        <button className={view === "agents" ? "on" : ""} aria-current={view === "agents" ? "page" : undefined} onClick={() => setView("agents")} title="Agents (A)">
          <Bot size={20} aria-hidden="true" />
          Agents
          {blocking > 0 && (
            <span className="badge" aria-label={`${blocking} waiting on you`}>
              {blocking}
            </span>
          )}
        </button>
        <button className={view === "library" ? "on" : ""} aria-current={view === "library" ? "page" : undefined} onClick={() => setView("library")} title="Library (L)">
          <Library size={20} aria-hidden="true" />
          Library
        </button>
        <div className="rail-end" />
        <button className={view === "settings" ? "on" : ""} aria-current={view === "settings" ? "page" : undefined} onClick={() => openSettings()} title={`Settings (${SETTINGS_KEY})`}>
          <Settings size={20} aria-hidden="true" />
          Settings
        </button>
      </nav>

      <main className="main">
        {view === "board" && <Board state={state} find={find} visible={visible} selectedId={sheet?.taskId} onOpen={open} />}
        {view === "products" && (
          <ProductsPage
            state={state}
            onSettings={openSettings}
            {...(mode === "engine" ? { onAdd: () => setAddingProduct(true) } : {})}
            onPick={(productId) => {
              setProduct(productId);
              setView("board");
            }}
          />
        )}
        {view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {view === "library" && <LibraryPage state={state} find={find} />}
        {view === "settings" && <SettingsPage state={state} product={productSettings} onProduct={setProductSettings} />}
      </main>

      {inboxOpen ? <Inbox ref={inboxPanel} state={state} find={find} overlay={overlay} landing={landing} onOpen={open} onClose={closeInbox} /> : <div />}

      {sheetTask && sheet && (
        <TaskSheet
          task={sheetTask}
          state={state}
          find={find}
          tab={sheet.tab}
          onTab={(tab) => setSheet({ taskId: sheetTask.id, tab })}
          onClose={close}
          onToast={(title, detail) => toast(title, detail ? [detail] : [])}
          {...(jump?.sheet ? { waiting: jump.line } : {})}
        />
      )}

      {addingProduct && (
        <AddProductDialog
          {...(jump ? { waiting: jump.line } : {})}
          onClose={() => setAddingProduct(false)}
          onAdded={(productId) => {
            setAddingProduct(false);
            setProduct(productId);
            setView("board");
          }}
        />
      )}

      {creating && (
        <NewTaskDialog
          state={state}
          {...(product !== "all" ? { defaultProduct: product } : {})}
          {...(jump ? { waiting: jump.line } : {})}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setView("board");
          }}
        />
      )}

      {mode === "engine" && status.desktop && status.link === "starting" && <StartingScreen />}
      {mode === "engine" && status.link === "failed" && <CouldNotStart problem={status.problem} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className="toast">
            <span className="avatar tone-amber" style={{ width: 28, height: 28 }} aria-hidden="true">
              <Bell size={16} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="t">{entry.title}</div>
              {entry.lines.map((line, index) => (
                <div key={index} className="s">
                  {line}
                </div>
              ))}
            </div>
            {entry.target && (
              <button
                className="btn small"
                onClick={() => {
                  // Exactly like a click on its notification.
                  const target = entry.target!;
                  setToasts((list) => list.filter((item) => item.id !== entry.id));
                  requestJump(target);
                }}
              >
                View
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface SearchProps {
  query: string;
  setQuery: (query: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

function SearchField({ query, setQuery, inputRef, autoFocus }: SearchProps & { autoFocus?: boolean }) {
  return (
    <label className="search-field">
      <Search size={16} aria-hidden="true" />
      <input ref={inputRef} autoFocus={autoFocus} aria-label="Find a task" placeholder="Find a task" value={query} onChange={(event) => setQuery(event.target.value)} />
      {query ? (
        <button className="btn ghost icon" aria-label="Clear the search" onClick={() => setQuery("")}>
          <X size={14} />
        </button>
      ) : (
        <kbd>⌘K</kbd>
      )}
    </label>
  );
}

/** In narrow windows search is a button that opens the field. */
function SearchButton({ open, setOpen, ...search }: SearchProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(box, open, close);
  return (
    <div style={{ position: "relative" }} ref={box}>
      <button className="btn ghost icon" aria-label={search.query ? `Find a task, searching for ${search.query}` : "Find a task"} title="Find a task (⌘K)" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Search size={18} aria-hidden="true" />
        {search.query && <span className="dot-on" aria-hidden="true" />}
      </button>
      {open && (
        <div className="popover search-pop" style={{ left: 0, right: "auto" }}>
          <SearchField {...search} autoFocus />
        </div>
      )}
    </div>
  );
}

interface MoreProps {
  state: State;
  find: Lookup;
  onOpen: (taskId: string, tab?: SheetTab) => void;
  status: EngineStatus;
  themeButton: ReactNode;
}

/** In the narrowest windows the pool, the theme and the connection status move here. */
function MoreMenu({ state, find, onOpen, status, themeButton }: MoreProps) {
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
            <PoolPanel state={state} find={find} onOpen={onOpen} onDone={close} />
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
