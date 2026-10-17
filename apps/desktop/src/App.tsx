import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, Boxes, Bot, Ellipsis, Hand, LayoutGrid, Library, Moon, Plus, Search, Settings, Sun, X } from "lucide-react";
import { boardOrder, draftFor, inboxOrder, inboxTab, keyArea, matchesWords, queueOf, reconcileHighlight, stepHighlight, withDraft, type KeyArea, type Page, type State, type Task, type TaskList } from "@petrina/core";
import { sim, mode, startClock, useEngineStatus, useSim, type EngineStatus } from "./engine";
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
import type { SheetTab } from "./components/TaskCard";
import { TakeOverDialogs } from "./components/TakeOver";
import { TaskSheet } from "./components/TaskSheet";
import { SettingsPage } from "./components/Settings";
import { canLand, landingFor, planJump } from "./notify/jump";
import { useNotices } from "./notify/useNotices";
import { waitingLine, type Notice, type Target } from "./notify/words";
import { applyTheme, initialTheme, type Theme } from "./theme";

import { CommandPalette, KeyboardShortcuts, taskState, type PaletteAction } from "./components/CommandPalette";
import { isTyping, mod, setSingleKeys, useSingleKeys } from "./keyboard";

type Sheet = { taskId: string; tab: SheetTab; list: TaskList; itemId?: string };

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

/** Below this width the inbox opens over the board instead of beside it. */
const DOCKED_INBOX = 1200;

export function App() {
  const state = useSim();
  const status = useEngineStatus();
  const find = useMemo(() => lookup(state), [state]);
  const viewport = useViewport();
  const [view, setView] = useState<Page>("board");
  const [product, setProduct] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const singleKeys = useSingleKeys();
  const [owner, setOwner] = useState<KeyArea>("board");
  const [boardId, setBoardId] = useState<string>();
  const [inboxId, setInboxId] = useState<string>();
  const [showDone, setShowDone] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messageFocus, setMessageFocus] = useState<string>();
  const messageFocused = useCallback(() => setMessageFocus(undefined), []);
  const [newTitle, setNewTitle] = useState("");
  const [inboxOpen, setInboxOpen] = useState(() => viewportSize().width >= DOCKED_INBOX);
  const [sheet, setSheet] = useState<Sheet>();
  const [creating, setCreating] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  // The product open in Settings' Products section.
  const [productSettings, setProductSettings] = useState<string>();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const focusArea = useRef<KeyArea | undefined>(undefined);
  const toastId = useRef(0);
  const [jump, setJump] = useState<Jump>();
  const [landing, setLanding] = useState<Landing>();
  const landings = useRef(0);
  // A notification that names no item opened the inbox: focusing it highlights nothing.
  const blankLanding = useRef(false);
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

  const showToast = useCallback((title: string, lines: readonly string[], target?: Target) => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-2), { id, title, lines, ...(target ? { target } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), 6000);
  }, []);
  const toast = useCallback((title: string, detail?: string) => showToast(title, detail ? [detail] : []), [showToast]);

  const visible = useCallback(
    (task: Task) => (product === "all" || task.productId === product) && matchesWords(query, task.title, find.product(task.productId)?.name ?? ""),
    [product, query, find],
  );
  const boardIds = useMemo(() => boardOrder(state.tasks, visible, showDone), [state.tasks, visible, showDone]);
  const items = useMemo(() => inboxOrder(state), [state]);
  const inboxIds = useMemo(() => items.map((item) => item.id), [items]);
  const previousBoard = useRef(boardIds);
  const previousInbox = useRef(inboxIds);
  const sheetOrder = useRef<readonly string[]>([]);
  useEffect(() => {
    const ids = sheet?.list === "board" ? boardIds : inboxIds;
    const id = sheet?.list === "board" ? sheet.taskId : sheet?.itemId;
    if (id && ids.includes(id)) sheetOrder.current = ids;
  }, [sheet, boardIds, inboxIds]);
  const currentBoardId = reconcileHighlight(previousBoard.current, boardIds, boardId);
  const currentInboxId = reconcileHighlight(previousInbox.current, inboxIds, inboxId);
  useEffect(() => { setBoardId(currentBoardId); previousBoard.current = boardIds; }, [currentBoardId, boardIds]);
  useEffect(() => { setInboxId(currentInboxId); previousInbox.current = inboxIds; }, [currentInboxId, inboxIds]);
  const area = keyArea(view, inboxOpen, owner, Boolean(sheet));
  const sheetTask = sheet ? find.task(sheet.taskId) : undefined;
  const highlightedItem = items.find((item) => item.id === currentInboxId);
  const focusedTask = sheetTask ?? (area === "inbox" ? find.task(highlightedItem?.taskId) : area === "board" ? find.task(currentBoardId) : undefined);
  const focusSnapshot = useRef<{ area: typeof area; id: string | undefined }>({ area, id: undefined });

  const open = useCallback((taskId: string, tab: SheetTab = "overview", list?: TaskList, itemId?: string) => {
    sheetOrder.current = list === "board" ? boardIds : list === "inbox" ? inboxIds : [];
    setMessageFocus(undefined);
    setSheet({ taskId, tab, list, ...(itemId ? { itemId } : {}) });
  }, [boardIds, inboxIds]);
  const close = useCallback(() => { setSheet(undefined); setMessageFocus(undefined); }, []);

  /**
   * Open the inbox where a notification points: at its item, scrolled into view, highlighted and
   * focused, with its task card highlighted briefly on the board. An item already handled opens
   * the inbox with a short note; a summary, or a click the system did not trace, opens the inbox
   * with nothing selected. The page and the product filter stay as they are.
   */
  const land = useCallback((target: Target) => {
    const { item, note } = landingFor(target, latest.current.state.inbox);
    setInboxOpen(true);
    setOwner("inbox");
    setInboxId(item?.id);
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
  }, []);

  /** A click on a notification, or View on an in-app message. Nothing typed is ever lost. */
  const requestJump = useCallback(
    (target: Target) => {
      dismissPopovers();
      setPalette(false);
      setShortcuts(false);
      const now = latest.current;
      const plan = planJump({ dialog: now.creating || now.addingProduct, sheet: now.sheet !== undefined, sheetTyped: hasTyping(document.querySelector(".sheet")) });
      if (plan.closeSheet) close();
      if (!plan.wait) {
        setJump(undefined);
        land(target);
        return;
      }
      const { item } = landingFor(target, now.state.inbox);
      const line = item ? waitingLine(item, now.state) : target.kind === "inbox" ? "Things in your inbox need you" : "Something you were notified about";
      setJump({ target, line, sheet: plan.sheetHolds });
    },
    [land, close],
  );

  // As soon as the window holding a jump closes, finished or cancelled, the inbox opens at it.
  useEffect(() => {
    if (!jump || !canLand({ dialog: creating || addingProduct, sheet: sheet !== undefined }, jump.sheet)) return;
    setJump(undefined);
    land(jump.target);
  }, [jump, creating, addingProduct, sheet, land]);

  const toastNotice = useCallback((notice: Notice) => showToast(notice.title, notice.lines, notice.target), [showToast]);
  useNotices({ onJump: requestJump, onToast: toastNotice });

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
  }, [landing]);
  const go = (page: Page) => { close(); setView(page); setOwner("board"); focusArea.current = page === "board" ? "board" : undefined; if (page === "settings") setProductSettings(undefined); };
  /** Settings, with one product's settings open when it comes from the Products page. */
  const openSettings = (productId?: string) => { go("settings"); setProductSettings(productId); };
  const openBoard = (id: string, tab: SheetTab = "overview") => { setOwner("board"); setBoardId(id); open(id, tab, "board"); if (tab === "session") setMessageFocus(id); };
  const openItem = (id: string, tab?: SheetTab) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    setOwner("inbox"); setInboxId(id); open(item.taskId, tab ?? inboxTab(item.kind), "inbox", id);
  };
  const openInbox = () => {
    close(); setInboxOpen(true); setOwner("inbox"); setInboxId(inboxIds[0]);
    blankLanding.current = false;
    focusArea.current = "inbox";
  };
  const closeInbox = () => {
    setInboxOpen(false); setOwner("board"); inboxButton.current?.focus();
  };
  const inboxKey = () => { close(); if (inboxOpen && owner === "inbox") closeInbox(); else openInbox(); };
  const newTask = (title = "") => { setNewTitle(title); setCreating(true); };
  const pickProduct = (id: string) => { close(); setProduct(id); setView("board"); setOwner("board"); };
  const message = (task: Task) => {
    if (sheet) setSheet({ ...sheet, tab: "session" });
    else if (area === "inbox" && highlightedItem) openItem(highlightedItem.id, "session");
    else if (area === "board") openBoard(task.id, "session");
    else open(task.id, "session");
    setMessageFocus(task.id);
  };
  const sendAction = async (action: () => unknown, title: string, detail?: string) => {
    if (status.link !== "live") { toast("Could not send that action", "Petrina is reconnecting. Try again when it is connected."); return false; }
    try { await action(); toast(title, detail); return true; }
    catch { toast("Could not send that action", "The engine did not confirm it. Try again when it is connected."); return false; }
  };
  const pause = (task: Task) => {
    const name = `“${task.title}”`;
    if (task.state === "queued") {
      void sendAction(() => sim.setHeld(task.id, !task.held), `${name} ${task.held ? "released" : "held"}`, task.held ? "It can start when a slot is free. P again holds it." : "It stays in the queue and will not start. P again releases it.");
    } else if (task.state === "paused") {
      const waitingForYou = state.inbox.some((item) => item.taskId === task.id && !item.blocking);
      void sendAction(() => sim.resume(task.id), `${name} resumed`, waitingForYou ? "It waits for you at its checkpoint." : "It is ready to start again when a slot is free.");
    } else if (["running", "needs-you", "waiting"].includes(task.state)) {
      const request = state.inbox.some((item) => item.taskId === task.id && (item.kind === "question" || item.kind === "permission") && item.blocking);
      const detail = request ? "Its open request was withdrawn and may be asked again. P to resume" : task.holdsSlot ? "The agent’s current step stopped and will start again after resuming. P to resume" : "It will not start another step. P to resume";
      void sendAction(() => sim.pause(task.id), `${name} paused`, detail);
    } else toast(`${name} cannot be paused`, task.state === "failed" ? "Use Try again to restart this task." : "This task has finished.");
  };
  const moved = async (task: Task, action: () => number | Promise<number>) => {
    if (task.state !== "queued") { toast(`“${task.title}” cannot move`, "It has already started. Only queued tasks have a priority."); return; }
    if (status.link !== "live") { toast("Could not change priority", "Petrina is reconnecting. Try again when it is connected."); return; }
    try {
      const hidden = await action();
      if (hidden >= 0) toast(`“${task.title}” moved`, hidden ? `It passed ${hidden} hidden task${hidden === 1 ? "" : "s"}. Their order stays the same.` : "Its queue position has updated.");
    } catch { toast("Could not change priority", "The engine did not confirm the move."); }
  };
  const move = (task: Task, direction: -1 | 1) => {
    const ids = state.tasks.filter((entry) => entry.state === "queued" && visible(entry)).map((entry) => entry.id);
    void moved(task, () => sim.moveVisibleInQueue(task.id, ids, direction));
  };
  const place = (id: string, anchor: string, side: "before" | "after") => {
    const task = find.task(id);
    const queue = queueOf(state.tasks);
    const from = queue.findIndex((entry) => entry.id === id);
    const to = queue.findIndex((entry) => entry.id === anchor);
    const hidden = queue.slice(Math.min(from, to) + 1, Math.max(from, to)).filter((entry) => !visible(entry)).length;
    if (task) void moved(task, async () => (await sim.placeInQueue(id, anchor, side)) < 0 ? -1 : hidden);
  };
  const walk = (direction: -1 | 1) => {
    if (sheet) {
      if (!sheet.list) { toast("J and K walk the board or the inbox", "Open a task there to walk that list."); return; }
      if (sheet.list === "board") {
        const id = stepHighlight(boardIds, sheet.taskId, direction, sheetOrder.current);
        if (id) { setBoardId(id); open(id, sheet.tab, "board"); }
      } else {
        const id = stepHighlight(inboxIds, sheet.itemId, direction, sheetOrder.current); if (id) openItem(id);
      }
    } else if (area === "inbox") setInboxId(stepHighlight(inboxIds, currentInboxId, direction));
    else if (area === "board") setBoardId(stepHighlight(boardIds, currentBoardId, direction));
  };

  useEffect(() => {
    const id = area === "board" ? currentBoardId : area === "inbox" ? currentInboxId : undefined;
    const changed = focusSnapshot.current.area !== area || focusSnapshot.current.id !== id;
    focusSnapshot.current = { area, id };
    // Closing a palette or dialog restores its opener. Only explicit navigation moves focus.
    if (!changed && !focusArea.current) return;
    if (area !== "board" && area !== "inbox") return;
    const attr = area === "board" ? "data-task-id" : "data-inbox-id";
    const el = id ? Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`)).find((node) => node.getAttribute(attr) === id) : area === "inbox" ? inboxPanel.current : document.querySelector<HTMLElement>(".board");
    if (id) el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Give Tab a starting point at the highlighted item, without taking focus from a field.
    if (el && !palette && !creating && !addingProduct && !shortcuts && (focusArea.current === area || (!el.contains(document.activeElement) && !isTyping(document.activeElement as HTMLElement)))) {
      el.focus({ preventScroll: true });
      focusArea.current = undefined;
    }
  }, [area, currentBoardId, currentInboxId, palette, creating, addingProduct, shortcuts]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement;
      const key = event.key.toLocaleLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!creating && !addingProduct) setPalette((on) => !on);
        return;
      }
      if (palette || creating || addingProduct || shortcuts) return;
      // Popovers handle their own keys. A task sheet is the one dialog with navigation keys.
      if (target.closest("[role=dialog]:not(.sheet), [role=menu], .popover, .menu") || document.querySelector(".popover, .menu")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (isTyping(target)) target.blur();
        else if (sheet) close();
        else if (area === "inbox") { setOwner("board"); inboxPanel.current?.blur(); }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "n") { event.preventDefault(); newTask(); return; }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") { event.preventDefault(); openSettings(); return; }
      if (isTyping(target) || event.metaKey || event.ctrlKey) return;
      if (event.altKey && (key === "arrowup" || key === "arrowdown")) {
        if (focusedTask) { event.preventDefault(); move(focusedTask, key === "arrowup" ? -1 : 1); } return;
      }
      if (key === "enter" && !target.closest("button, a, [role=button], [role=radio]")) {
        if (area === "board" && currentBoardId) { event.preventDefault(); openBoard(currentBoardId); }
        else if (area === "inbox" && currentInboxId) { event.preventDefault(); openItem(currentInboxId); }
        return;
      }
      if (event.altKey || !singleKeys) return;
      if (event.repeat && ["p", "i", "m", "?"].includes(key)) return;
      if (key === "i") { event.preventDefault(); inboxKey(); }
      else if (key === "b" || key === "a" || key === "l") { event.preventDefault(); go(key === "b" ? "board" : key === "a" ? "agents" : "library"); }
      else if (key === "?") { event.preventDefault(); setShortcuts(true); }
      else if ((key === "j" || key === "k") && area) { event.preventDefault(); walk(key === "j" ? 1 : -1); }
      else if (key === "p" && focusedTask) { event.preventDefault(); pause(focusedTask); }
      else if (key === "m" && focusedTask) { event.preventDefault(); message(focusedTask); }
    };
    // Capture gives Escape one owner before nested dialogs or text controls see it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const actions: PaletteAction[] = [
    { id: "new", label: "New task", shortcut: `${mod}N`, run: () => newTask() },
    { id: "pool", label: state.pool.paused ? "Resume pool" : "Pause pool", shortcut: "↵", run: () => { void sendAction(() => sim.setPoolPaused(!state.pool.paused), state.pool.paused ? "Pool resumed" : "Pool paused", state.pool.paused ? "New stages can start." : "Running stages finish. Nothing new starts."); } },
    { id: "limit", label: "Change the pool limit", detail: `Currently ${state.pool.limit} · Lowering never stops anyone`, shortcut: "↵", run: () => {} },
    { id: "inbox", label: "Open the inbox", shortcut: "I", run: openInbox },
    ...(["board", "products", "agents", "library", "settings"] as Page[]).map((page) => ({ id: page, label: `Go to ${page[0]!.toUpperCase()}${page.slice(1)}`, shortcut: ({ board: "B", products: "↵", agents: "A", library: "L", settings: `${mod},` })[page], run: () => go(page) })),
    { id: "shortcuts", label: "Keyboard shortcuts", shortcut: "?", run: () => setShortcuts(true) },
    { id: "toggle-keys", label: `Turn single-key shortcuts ${singleKeys ? "off" : "on"}`, shortcut: "↵", run: () => setSingleKeys(!singleKeys) },
  ];
  const taskActions: PaletteAction[] = focusedTask ? [
    { id: "open-task", label: `Open “${focusedTask.title}”`, shortcut: "↵", run: () => { if (!sheet) open(focusedTask.id); } },
    { id: "message-task", label: `Message “${focusedTask.title}”`, shortcut: "M", run: () => { if (sheet) message(focusedTask); else { open(focusedTask.id, "session"); setMessageFocus(focusedTask.id); } } },
    { id: "pause-task", label: `${focusedTask.state === "queued" ? focusedTask.held ? "Release" : "Hold" : focusedTask.state === "paused" ? "Resume" : "Pause"} “${focusedTask.title}”`, shortcut: "P", run: () => pause(focusedTask) },
    ...(focusedTask.state === "queued" && queueOf(state.tasks)[0]?.id !== focusedTask.id ? [{ id: "top-task", label: `Move “${focusedTask.title}” to top`, shortcut: "↵", run: () => {
      const hidden = queueOf(state.tasks).slice(0, queueOf(state.tasks).findIndex((task) => task.id === focusedTask.id)).filter((task) => !visible(task)).length;
      void sendAction(() => sim.moveToTop(focusedTask.id), `“${focusedTask.title}” moved to the top`, hidden ? `It passed ${hidden} hidden task${hidden === 1 ? "" : "s"}. Their order stays the same.` : undefined);
    } }] : []),
  ] : [];
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
        <ProductSwitcher state={state} value={product} onChange={pickProduct} />
        <div className="palette-launcher">
          <button className={searchField ? "search-field palette-trigger" : "btn ghost icon"} aria-label="Find tasks, products or actions" title={`Command palette (${mod}K)`} onClick={() => setPalette(true)}>
            <Search size={18} aria-hidden="true" />{searchField && <><span>Find tasks or actions</span><kbd>{mod}K</kbd></>}
          </button>
          {query && <span className="active-filter"><span title={query}>{query}</span><button aria-label="Clear the board filter" onClick={() => setQuery("")}><X size={14} /></button></span>}
        </div>
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
        <button className="btn primary" onClick={() => newTask()} title={`New task (${mod}N)`}>
          <Plus size={16} aria-hidden="true" />
          New task
        </button>
        {barExtras ? themeButton : <MoreMenu state={state} find={find} onOpen={open} status={status} themeButton={themeButton} />}
      </header>
      {recovery && <EngineRecovery status={status} />}

      <nav className="rail" aria-label="Sections">
        <button className={view === "board" ? "on" : ""} aria-current={view === "board" ? "page" : undefined} onClick={() => go("board")} title="Board (B)">
          <LayoutGrid size={20} aria-hidden="true" />
          Board
        </button>
        <button className={view === "products" ? "on" : ""} aria-current={view === "products" ? "page" : undefined} onClick={() => go("products")} title="Products">
          <Boxes size={20} aria-hidden="true" />
          Products
        </button>
        <button className={view === "agents" ? "on" : ""} aria-current={view === "agents" ? "page" : undefined} onClick={() => go("agents")} title="Agents (A)">
          <Bot size={20} aria-hidden="true" />
          Agents
          {blocking > 0 && (
            <span className="badge" aria-label={`${blocking} waiting on you`}>
              {blocking}
            </span>
          )}
        </button>
        <button className={view === "library" ? "on" : ""} aria-current={view === "library" ? "page" : undefined} onClick={() => go("library")} title="Library (L)">
          <Library size={20} aria-hidden="true" />
          Library
        </button>
        <button className={view === "settings" ? "on" : ""} aria-current={view === "settings" ? "page" : undefined} onClick={() => go("settings")} title={`Settings (${mod},)`}><Settings size={20} aria-hidden="true" />Settings</button>
      </nav>

      <main className="main">
        {view === "board" && <Board state={state} find={find} visible={visible} selectedId={area === "board" ? currentBoardId : undefined} onOpen={openBoard} onFocus={(id) => { setOwner("board"); if (id) setBoardId(id); }} showDone={showDone} onShowDone={setShowDone} drafts={drafts} onPlace={place} />}
        {view === "products" && (
          <ProductsPage
            state={state}
            onSettings={openSettings}
            {...(mode === "engine" ? { onAdd: () => setAddingProduct(true) } : {})}
            onPick={pickProduct}
          />
        )}
        {view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {view === "library" && <LibraryPage state={state} find={find} />}
        {view === "settings" && <SettingsPage state={state} product={productSettings} onProduct={setProductSettings} onShortcuts={() => setShortcuts(true)} />}
      </main>

      {inboxOpen ? <Inbox ref={inboxPanel} state={state} find={find} overlay={overlay && !sheet} landing={landing} onOpen={open} onClose={closeInbox} selectedId={area === "inbox" ? currentInboxId : undefined} onFocus={(id) => {
        setOwner("inbox");
        if (!id && blankLanding.current) return;
        blankLanding.current = false;
        setInboxId(id ?? currentInboxId ?? inboxIds[0]);
      }} onOpenItem={openItem} /> : <div />}

      {sheetTask && sheet && (
        <TaskSheet task={sheetTask} state={state} find={find} tab={sheet.tab} onTab={(tab) => setSheet({ ...sheet, tab })} draft={draftFor(drafts, sheetTask.id)} onDraft={(text) => setDrafts((all) => withDraft(all, sheetTask.id, text))} messageFocus={messageFocus === sheetTask.id} onMessageFocused={messageFocused} onMessage={() => message(sheetTask)} onClose={close} onToast={(title, detail) => toast(title, detail)} {...(jump?.sheet ? { waiting: jump.line } : {})} />
      )}

      <TakeOverDialogs state={state} find={find} onToast={(title, detail) => toast(title, detail)} />

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
          initialTitle={newTitle}
          {...(jump ? { waiting: jump.line } : {})}
          {...(product !== "all" ? { defaultProduct: product } : {})}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            go("board");
          }}
        />
      )}

      {palette && <CommandPalette state={state} actions={actions} taskActions={taskActions} onClose={() => setPalette(false)} onTask={(id) => open(id)} onProduct={pickProduct} onNew={newTask} onFilter={(text) => { setQuery(text); go("board"); }} onLimit={(limit) => { void sendAction(() => sim.setPoolLimit(limit), `Pool limit set to ${limit}`, "Lowering the limit never stops anyone."); }} />}
      {shortcuts && <KeyboardShortcuts onClose={() => setShortcuts(false)} />}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{focusedTask ? `${focusedTask.title}, ${taskState(focusedTask, state)}${area === "inbox" && highlightedItem ? `, ${highlightedItem.title}` : ""}` : ""}</div>

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
