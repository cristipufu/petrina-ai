import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardOrder, draftFor, inboxOrder, inboxTab, keyArea, matchesWords, reconcileHighlight, stepHighlight, withDraft, type KeyArea, type Page, type State, type Task, type TaskList } from "@petrina/core";
import { sim, mode, startClock, useEngineStatus, useSim, type EngineStatus } from "./engine";
import { AddProductDialog } from "./components/AddProduct";
import { AnalyticsPage } from "./components/Analytics";
import { CouldNotStart, EngineRecovery, StartingScreen } from "./components/EngineState";
import { clearFirstTaskDraft, FirstRun } from "./components/FirstRun";
import { blockingCount, lookup } from "./lib";
import { useViewport, viewportSize } from "./components/bits";
import { Board } from "./components/Board";
import { Inbox } from "./components/Inbox";
import { NewTaskDialog } from "./components/NewTask";
import { AgentsPage, LibraryPage } from "./components/Pages";
import { ProductsPage } from "./components/Products";
import { Rail } from "./components/Rail";
import type { SheetTab } from "./components/TaskCard";
import { TakeOverDialogs } from "./components/TakeOver";
import { TaskSheet } from "./components/TaskSheet";
import { TopBar } from "./components/TopBar";
import { SettingsPage } from "./components/Settings";
import { useLanding } from "./notify/useLanding";
import { useNotices } from "./notify/useNotices";
import type { Notice } from "./notify/words";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { CommandPalette, KeyboardShortcuts, taskState } from "./components/CommandPalette";
import { isTyping, useSingleKeys } from "./keyboard";
import { useGlobalKeys } from "./globalKeys";
import { appActions, taskActions } from "./paletteActions";
import { taskCommands } from "./taskCommands";
import { Toasts, useToasts } from "./toasts";

// The app's frame: which page shows, the board and inbox highlights and focus, the task sheet and the
// dialogs. The top bar, the rail, the keyboard, the palette's actions, notification landings and toasts
// each live in a module of their own.

type Sheet = { taskId: string; tab: SheetTab; list: TaskList; itemId?: string };

/** Below this width the inbox opens over the board instead of beside it. */
const DOCKED_INBOX = 1200;

/**
 * What the window shows. Until the engine's real state has arrived: "Starting Petrina…", so nobody
 * sees an empty board, or first run, by mistake. A browser tab whose saved key the engine refuses
 * is the exception: it says how to open a fresh window, because starting the engine cannot fix
 * that key. Then first run while setup is not done (never over the demo, except its own variant),
 * or the workspace. The couldn't-start message goes over either.
 */
export function App() {
  const state = useSim();
  const status = useEngineStatus();
  const failed = mode === "engine" && status.link === "failed" && <CouldNotStart problem={status.problem} />;
  if (mode === "engine" && !status.synced) {
    return (
      <>
        <StartingScreen status={status} />
        {failed}
      </>
    );
  }
  if (state.setup && !state.setup.done) {
    return (
      <>
        <FirstRun state={state} status={status} />
        {failed}
      </>
    );
  }
  return <Workspace state={state} status={status} />;
}

function Workspace({ state, status }: { state: State; status: EngineStatus }) {
  const find = useMemo(() => lookup(state), [state]);
  const viewport = useViewport();
  const [view, setView] = useState<Page>("board");
  /** "About these numbers" opens with Analytics when a task sheet's link leads there. */
  const [aboutNumbers, setAboutNumbers] = useState(false);
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
  // The engine adds any clone. Of the demos, only first run's has clones to add, Skip setup included.
  const canAddProduct = mode === "engine" || state.setup !== undefined;
  // The product open in Settings' Products section.
  const [productSettings, setProductSettings] = useState<string>();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const focusArea = useRef<KeyArea | undefined>(undefined);
  const { toasts, showToast, toast, dismiss } = useToasts();
  // Read by notification clicks, which arrive outside React's renders.
  const latest = useRef({ state, dialog: creating || addingProduct, sheet: sheet !== undefined });
  latest.current = { state, dialog: creating || addingProduct, sheet: sheet !== undefined };

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
  // Setup is done: a first task draft left behind (its reply was lost) has nothing to come back to.
  // Only this mode's draft: the demo never clears one still being written for the real engine.
  useEffect(() => clearFirstTaskDraft(), []);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (product !== "all" && !state.products.some((entry) => entry.id === product)) setProduct("all");
  }, [state.products, product]);


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
  const [paletteTaskId, setPaletteTaskId] = useState<string>();
  const openPalette = () => { setPaletteTaskId(focusedTask?.id); setPalette(true); };
  const focusSnapshot = useRef<{ area: typeof area; id: string | undefined }>({ area, id: undefined });

  const open = useCallback((taskId: string, tab: SheetTab = "overview", list?: TaskList, itemId?: string) => {
    sheetOrder.current = list === "board" ? boardIds : list === "inbox" ? inboxIds : [];
    setMessageFocus(undefined);
    setSheet({ taskId, tab, list, ...(itemId ? { itemId } : {}) });
  }, [boardIds, inboxIds]);
  const close = useCallback(() => { setSheet(undefined); setMessageFocus(undefined); }, []);
  /** Go to Analytics, optionally with "About these numbers" open. */
  const analytics = useCallback((about = false) => {
    close();
    setView("analytics");
    setOwner("board");
    setAboutNumbers(about);
  }, [close]);
  const aboutSeen = useCallback(() => setAboutNumbers(false), []);

  const openInboxAt = useCallback((who: KeyArea, itemId: string | undefined) => {
    setInboxOpen(true);
    setOwner(who);
    setInboxId(itemId);
  }, []);
  const closeOverlays = useCallback(() => {
    setPalette(false);
    setShortcuts(false);
  }, []);
  const { jump, landing, requestJump, blankLanding } = useLanding({ latest, inboxPanel, closeSheet: close, closeOverlays, openInboxAt });

  const toastNotice = useCallback((notice: Notice) => showToast(notice.title, notice.lines, notice.target), [showToast]);
  useNotices({ onJump: requestJump, onToast: toastNotice });

  const show = (page: Page) => { setView(page); setOwner("board"); focusArea.current = page === "board" ? "board" : undefined; if (page === "settings") setProductSettings(undefined); };
  const go = (page: Page) => { close(); show(page); };
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
  const closeInbox = (keepButton: boolean) => {
    focusArea.current = !keepButton && view === "board" ? "board" : undefined;
    setInboxOpen(false); setOwner("board"); inboxButton.current?.focus();
  };
  const inboxKey = () => { close(); if (inboxOpen && owner === "inbox") closeInbox(false); else openInbox(); };
  const newTask = (title = "") => { setNewTitle(title); setCreating(true); };
  const pickProduct = (id: string) => { close(); setProduct(id); if (view !== "analytics") setView("board"); setOwner("board"); };
  const message = (task: Task) => {
    if (sheet) setSheet({ ...sheet, tab: "session" });
    else if (area === "inbox" && highlightedItem) openItem(highlightedItem.id, "session");
    else if (area === "board") openBoard(task.id, "session");
    else open(task.id, "session");
    setMessageFocus(task.id);
  };
  const { sendAction, pause, move, place } = taskCommands({ state, find, live: () => status.link === "live", visible, toast });
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
    const leftInbox = focusSnapshot.current.area === "inbox" && area !== "inbox";
    focusSnapshot.current = { area, id };
    // Button clicks and overlay Escape stay on the Inbox button; explicit board navigation moves on.
    if (leftInbox && document.activeElement === inboxButton.current && !focusArea.current) return;
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

  useGlobalKeys({
    palette,
    modal: creating || addingProduct || shortcuts,
    sheetOpen: Boolean(sheet),
    area,
    singleKeys,
    focusedTask,
    boardId: currentBoardId,
    inboxId: currentInboxId,
    togglePalette: () => {
      if (creating || addingProduct) return;
      if (palette) setPalette(false);
      else openPalette();
    },
    closeSheet: close,
    // Over the board the inbox hides and hands focus to the Inbox button. Docked, it hands the keys to the
    // board, and off the board to nothing: no hidden Enter, and no palette handing them back on close.
    leaveInbox: () => {
      if (overlay) { closeInbox(true); return; }
      setOwner("board");
      if (inboxPanel.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    },
    newTask: () => newTask(),
    openSettings: () => openSettings(),
    move,
    openBoard: (id) => openBoard(id),
    openItem: (id) => openItem(id),
    inboxKey,
    go,
    showShortcuts: () => setShortcuts(true),
    walk,
    pause,
    message,
  });

  // The palette's task rows stay with the task in focus when it opened, and go if that task does.
  const paletteTask = palette ? find.task(paletteTaskId) : undefined;
  const actions = appActions({ state, singleKeys, newTask: () => newTask(), openInbox, go, showShortcuts: () => setShortcuts(true), sendAction });
  const forTask = taskActions({ task: paletteTask, state, sheetOpen: sheet?.taskId === paletteTask?.id, open, message, focusMessage: setMessageFocus, pause, visible, sendAction });
  const blocking = blockingCount(state);
  const docked = inboxOpen && !overlay;
  const recovery = mode === "engine" && !status.desktop && status.link !== "live" && status.recovery;

  return (
    <div className={`app ${recovery ? "with-engine-hint" : ""}`} style={{ gridTemplateColumns: `var(--rail) minmax(0, 1fr) ${docked ? "auto" : "0px"}` }}>
      <TopBar
        state={state}
        find={find}
        status={status}
        room={{ roomy, searchField, poolSquares, barExtras, inboxLabel }}
        product={product}
        onProduct={pickProduct}
        query={query}
        onClearQuery={() => setQuery("")}
        onPalette={openPalette}
        blocking={blocking}
        inboxOpen={inboxOpen}
        inboxButton={inboxButton}
        onOpenInbox={openInbox}
        onToggleInbox={() => (inboxOpen ? closeInbox(true) : openInbox())}
        onNewTask={() => newTask()}
        theme={theme}
        onTheme={setTheme}
        onOpen={open}
        onAnalytics={() => analytics()}
      />
      {recovery && <EngineRecovery status={status} />}

      <Rail view={view} blocking={blocking} onGo={go} />
      <main className="main">
        {view === "board" && (
          <Board
            state={state}
            find={find}
            visible={visible}
            selectedId={area === "board" ? currentBoardId : undefined}
            onOpen={openBoard}
            onFocus={(id) => { setOwner("board"); if (id) setBoardId(id); }}
            showDone={showDone}
            onShowDone={setShowDone}
            drafts={drafts}
            onPlace={place}
            onNewTask={() => newTask()}
            onShowInbox={openInbox}
            {...(canAddProduct ? { onAddProduct: () => setAddingProduct(true) } : {})}
          />
        )}
        {view === "products" && (
          <ProductsPage
            state={state}
            onSettings={openSettings}
            {...(canAddProduct ? { onAdd: () => setAddingProduct(true) } : {})}
            onPick={pickProduct}
          />
        )}
        {view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {view === "analytics" && <AnalyticsPage state={state} find={find} product={product} about={aboutNumbers} onAboutSeen={aboutSeen} onOpen={(taskId) => open(taskId)} />}
        {view === "library" && <LibraryPage state={state} find={find} />}
        {view === "settings" && <SettingsPage state={state} product={productSettings} onProduct={setProductSettings} onShortcuts={() => setShortcuts(true)} />}
      </main>

      {inboxOpen ? <Inbox ref={inboxPanel} state={state} find={find} overlay={overlay && !sheet} landing={landing} onOpen={open} onClose={() => closeInbox(false)} selectedId={area === "inbox" ? currentInboxId : undefined} onFocus={(id) => {
        setOwner("inbox");
        if (!id && blankLanding.current) return;
        blankLanding.current = false;
        setInboxId(id ?? currentInboxId ?? inboxIds[0]);
      }} onOpenItem={openItem} /> : <div />}

      {sheetTask && sheet && (
        <TaskSheet task={sheetTask} state={state} find={find} tab={sheet.tab} onTab={(tab) => setSheet({ ...sheet, tab })} draft={draftFor(drafts, sheetTask.id)} onDraft={(text) => setDrafts((all) => withDraft(all, sheetTask.id, text))} messageFocus={messageFocus === sheetTask.id} onMessageFocused={messageFocused} onMessage={() => message(sheetTask)} onClose={close} onToast={(title, detail) => toast(title, detail)} onAboutNumbers={() => analytics(true)} {...(jump?.sheet ? { waiting: jump.line } : {})} />
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
            // An open task keeps its page and list return point while the new task joins the queue.
            if (!sheet) show("board");
          }}
        />
      )}

      {palette && <CommandPalette state={state} actions={actions} taskActions={forTask} onClose={() => setPalette(false)} onTask={(id) => open(id)} onProduct={pickProduct} onNew={newTask} onFilter={(text) => { setQuery(text); go("board"); }} onLimit={(limit) => { void sendAction(() => sim.setPoolLimit(limit), `Pool limit set to ${limit}`, "Lowering the limit never stops anyone."); }} />}
      {shortcuts && <KeyboardShortcuts onClose={() => setShortcuts(false)} />}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{focusedTask ? `${focusedTask.title}, ${taskState(focusedTask, state)}${area === "inbox" && highlightedItem ? `, ${highlightedItem.title}` : ""}` : ""}</div>

      {mode === "engine" && status.link === "failed" && <CouldNotStart problem={status.problem} />}

      <Toasts
        toasts={toasts}
        onView={(entry) => {
          // Exactly like a click on its notification.
          dismiss(entry.id);
          requestJump(entry.target!);
        }}
      />
    </div>
  );
}
