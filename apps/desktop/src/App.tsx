import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bell, Boxes, Bot, Ellipsis, Hand, LayoutGrid, Library, Moon, Plus, Search, Sun, X } from "lucide-react";
import type { State, Task } from "@petrina/core";
import { mode, startClock, useEngineStatus, useSim, type EngineStatus } from "./engine";
import { AddProductDialog } from "./components/AddProduct";
import { CouldNotStart, EnginePill, EngineRecovery, StartingScreen } from "./components/EngineState";
import { blockingCount, lookup, type Lookup } from "./lib";
import { Logo, useDismiss, useViewport, viewportSize } from "./components/bits";
import { Board } from "./components/Board";
import { Inbox } from "./components/Inbox";
import { NewTaskDialog } from "./components/NewTask";
import { AgentsPage, LibraryPage } from "./components/Pages";
import { PoolButton, PoolPanel } from "./components/Pool";
import { ProductsPage, ProductSwitcher } from "./components/Products";
import type { SheetTab } from "./components/TaskCard";
import { TakeOverDialogs } from "./components/TakeOver";
import { TaskSheet } from "./components/TaskSheet";
import { applyTheme, initialTheme, type Theme } from "./theme";

type View = "board" | "products" | "agents" | "library";

interface Toast {
  id: number;
  title: string;
  detail?: string;
  taskId?: string;
}

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
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const seenInbox = useRef(new Set(state.inbox.map((item) => item.id)));
  const toastId = useRef(0);

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

  const toast = useCallback((title: string, detail?: string, taskId?: string) => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-2), { id, title, ...(detail ? { detail } : {}), ...(taskId ? { taskId } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), 6000);
  }, []);

  // Anything new that needs the coordinator gets a toast (a system notification in the desktop build).
  useEffect(() => {
    for (const item of state.inbox) {
      if (seenInbox.current.has(item.id)) continue;
      seenInbox.current.add(item.id);
      // The coordinator just took over themselves: the take-over says so already.
      if (item.kind === "driving") continue;
      const task = find.task(item.taskId);
      const role = find.role(item.roleId);
      toast(item.title, `${task?.title ?? ""}${role ? ` · ${role.name}` : ""}`, item.taskId);
    }
  }, [state.inbox, find, toast]);

  const open = useCallback((taskId: string, tab: SheetTab = "overview") => {
    setSheet({ taskId, tab });
    if (viewportSize().width < DOCKED_INBOX) setInboxOpen(false);
  }, []);
  const close = useCallback(() => setSheet(undefined), []);

  const openInbox = useCallback(() => setInboxOpen(true), []);
  // Closing the inbox hands focus back to the button that opens it.
  const closeInbox = useCallback(() => {
    setInboxOpen(false);
    inboxButton.current?.focus();
  }, []);

  // Over the board, the inbox takes focus when it opens.
  useEffect(() => {
    if (inboxOpen && overlay) inboxPanel.current?.focus();
  }, [inboxOpen, overlay]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[aria-modal="true"]')) return;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCreating(true);
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
  }, [openInbox, closeInbox]);

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
      </nav>

      <main className="main">
        {view === "board" && <Board state={state} find={find} visible={visible} selectedId={sheet?.taskId} onOpen={open} />}
        {view === "products" && (
          <ProductsPage
            state={state}
            onRemoved={(productId) => { if (product === productId) setProduct("all"); }}
            {...(mode === "engine" ? { onAdd: () => setAddingProduct(true) } : {})}
            onPick={(productId) => {
              setProduct(productId);
              setView("board");
            }}
          />
        )}
        {view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {view === "library" && <LibraryPage state={state} find={find} />}
      </main>

      {inboxOpen ? <Inbox ref={inboxPanel} state={state} find={find} overlay={overlay} onOpen={open} onClose={closeInbox} /> : <div />}

      {sheetTask && sheet && (
        <TaskSheet task={sheetTask} state={state} find={find} tab={sheet.tab} onTab={(tab) => setSheet({ taskId: sheetTask.id, tab })} onClose={close} onToast={(title, detail) => toast(title, detail)} />
      )}

      <TakeOverDialogs state={state} find={find} onToast={(title, detail) => toast(title, detail)} />

      {addingProduct && (
        <AddProductDialog
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
              {entry.detail && <div className="s">{entry.detail}</div>}
            </div>
            {entry.taskId && (
              <button
                className="btn small"
                onClick={() => {
                  openInbox();
                  setToasts((list) => list.filter((item) => item.id !== entry.id));
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
