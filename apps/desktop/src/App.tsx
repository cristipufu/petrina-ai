import { involvesProduct, taskProductIds } from "@petrina/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardOrder, draftFor, inboxOrder, inboxTab, keyArea, matchesWords, reconcileHighlight, stepHighlight, withDraft, type KeyArea, type Page, type State, type Task, type TaskList } from "@petrina/core";
import { failureText, sim, mode, startClock, useEngineStatus, useSim, type EngineStatus } from "./engine";
import { AddProductDialog } from "./components/AddProduct";
import { AnalyticsPage } from "./components/Analytics";
import { CouldNotStart, EngineRecovery, StartingScreen } from "./components/EngineState";
import { clearFirstTaskDraft, FirstRun } from "./components/FirstRun";
import { blockingCount, lookup } from "./lib";
import { useViewport, viewportSize } from "./components/bits";
import { Board } from "./components/Board";
import { History, TaskLoading, useHistoryPage, type HistoryPosition } from "./components/History";
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
import { PAGE_NAMES, routeHref, useAppRoute } from "./routes";

// The app's frame: which page shows, the board and inbox highlights and focus, the task sheet and the
// dialogs. The top bar, the rail, the keyboard, the palette's actions, notification landings and toasts
// each live in a module of their own.

import { RolePanel, type RolePanelTarget } from "./components/Roles";

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
  const [route, navigate] = useAppRoute();
  const { view, product, sheet, productSettings } = route;
  const setSheet = useCallback((next: typeof sheet) => navigate((previous) => ({ ...previous, sheet: next })), [navigate]);
  const [rolePanel, setRolePanel] = useState<RolePanelTarget>();
  const setProductSettings = (next: string | undefined) => navigate((previous) => ({ ...previous, view: "products", productSettings: next }));
  /** "About these numbers" opens with Analytics when a task sheet's link leads there. */
  const [aboutNumbers, setAboutNumbers] = useState(false);
  const [query, setQuery] = useState("");
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const singleKeys = useSingleKeys();
  const [owner, setOwner] = useState<KeyArea>("board");
  const [boardId, setBoardId] = useState<string>();
  // Keep the last task as the keyboard's anchor, without painting a pointer click as selection.
  const [boardKeyboard, setBoardKeyboard] = useState(false);
  const [inboxId, setInboxId] = useState<string>();
  const history = useHistoryPage(state, view === "history", product, route.history);
  const historyIds = useMemo(() => history.page?.items.map((task) => task.id) ?? [], [history.page]);
  const setHistoryPosition = (position: HistoryPosition) => navigate((previous) => ({ ...previous, history: position, sheet: undefined }));
  const [fetchedTask, setFetchedTask] = useState<{ id: string; task?: Task; error?: string }>();
  const [detailsRetry, setDetailsRetry] = useState(0);
  const liveSheetTask = sheet ? find.task(sheet.taskId) : undefined;
  const wantedTaskId = sheet?.taskId;
  useEffect(() => {
    if (!wantedTaskId || liveSheetTask) return;
    let cancelled = false;
    Promise.resolve().then(() => sim.taskDetails(wantedTaskId)).then(
      (task) => { if (!cancelled) setFetchedTask({ id: wantedTaskId, task }); },
      (error) => { if (!cancelled) setFetchedTask({ id: wantedTaskId, error: failureText(error) }); },
    );
    return () => { cancelled = true; };
  }, [wantedTaskId, Boolean(liveSheetTask), detailsRetry]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messageFocus, setMessageFocus] = useState<string>();
  const messageFocused = useCallback(() => setMessageFocus(undefined), []);
  const [newTitle, setNewTitle] = useState("");
  const [inboxOpen, setInboxOpen] = useState(() => viewportSize().width >= DOCKED_INBOX);
  const [creating, setCreating] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  // The engine adds any clone. Of the demos, only first run's has clones to add, Skip setup included.
  const canAddProduct = mode === "engine" || state.setup !== undefined;
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const focusArea = useRef<KeyArea | undefined>(undefined);
  const { toasts, showToast, toast, dismiss } = useToasts();
  // Read by notification clicks, which arrive outside React's renders.
  const latest = useRef({ state, dialog: creating || addingProduct || Boolean(rolePanel), sheet: sheet !== undefined });
  latest.current = { state, dialog: creating || addingProduct || Boolean(rolePanel), sheet: sheet !== undefined };

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
    if (!route.missing && product !== "all" && !state.products.some((entry) => entry.id === product)) navigate((previous) => ({ ...previous, product: "all" }), true);
  }, [state.products, product, route.missing, navigate]);


  const visible = useCallback(
    (task: Task) => (product === "all" || involvesProduct(task, product)) && matchesWords(query, task.title, ...taskProductIds(task).map((id) => find.product(id)?.name ?? "")),
    [product, query, find],
  );
  const activeBoardIds = useMemo(() => boardOrder(state.tasks, visible, false), [state.tasks, visible]);
  const lastHistoryIds = useRef<readonly string[]>([]);
  if (history.page) lastHistoryIds.current = historyIds;
  const boardIds = view === "history" ? history.page ? historyIds : lastHistoryIds.current : activeBoardIds;
  const items = useMemo(() => inboxOrder(state), [state]);
  const inboxIds = useMemo(() => items.map((item) => item.id), [items]);
  const previousBoard = useRef(boardIds);
  const previousInbox = useRef(inboxIds);
  const sheetOrder = useRef<readonly string[]>([]);
  useEffect(() => {
    const ids = sheet?.list === "board" || sheet?.list === "history" ? boardIds : inboxIds;
    const id = sheet?.list === "board" || sheet?.list === "history" ? sheet.taskId : sheet?.itemId;
    if (id && ids.includes(id)) sheetOrder.current = ids;
  }, [sheet, boardIds, inboxIds]);
  const currentBoardId = reconcileHighlight(previousBoard.current, boardIds, boardId);
  const currentInboxId = reconcileHighlight(previousInbox.current, inboxIds, inboxId);
  useEffect(() => { setBoardId(currentBoardId); previousBoard.current = boardIds; }, [currentBoardId, boardIds]);
  useEffect(() => { setInboxId(currentInboxId); previousInbox.current = inboxIds; }, [currentInboxId, inboxIds]);
  const area = keyArea(view, inboxOpen, owner, Boolean(sheet));
  const sheetTask = liveSheetTask ?? (fetchedTask?.id === wantedTaskId ? fetchedTask?.task : undefined);
  const loadingDetails = Boolean(sheet && !sheetTask && fetchedTask?.id !== wantedTaskId);
  const detailsError = !sheetTask && fetchedTask?.id === wantedTaskId ? fetchedTask?.error : undefined;
  // Only the open historical task joins this view of the sheet. The board and Analytics keep the engine projection.
  const detailState = useMemo(() => sheetTask && !liveSheetTask ? { ...state, tasks: [...state.tasks, sheetTask] } : state, [state, sheetTask, liveSheetTask]);
  const detailFind = useMemo(() => lookup(detailState), [detailState]);
  const missing = route.missing ? "Page not found"
    : sheet && !sheetTask && !loadingDetails && !detailsError ? "Task not found"
    : productSettings && !find.product(productSettings) ? "Product not found" : undefined;
  const highlightedItem = items.find((item) => item.id === currentInboxId);
  const focusedTask = sheetTask ?? (area === "inbox" ? find.task(highlightedItem?.taskId) : area === "board" ? find.task(currentBoardId) : undefined);
  const [paletteTaskId, setPaletteTaskId] = useState<string>();
  const openPalette = () => { setPaletteTaskId(focusedTask?.id); setPalette(true); };
  const focusSnapshot = useRef<{ area: typeof area; id: string | undefined }>({ area, id: undefined });
  // While a pointer is pressed, a highlight it moves does not scroll: the button would move away before the click lands.
  const pressing = useRef(false);
  useEffect(() => {
    const down = () => { pressing.current = true; setBoardKeyboard(false); };
    const up = () => { pressing.current = false; };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);

  const open = useCallback((taskId: string, tab: SheetTab = "overview", list?: TaskList, itemId?: string) => {
    sheetOrder.current = list === "board" || list === "history" ? boardIds : list === "inbox" ? inboxIds : [];
    setMessageFocus(undefined);
    setSheet({ taskId, tab, list, ...(itemId ? { itemId } : {}) });
  }, [boardIds, inboxIds]);
  const close = useCallback(() => { setSheet(undefined); setMessageFocus(undefined); }, []);
  /** Go to Analytics, optionally with "About these numbers" open. */
  const analytics = useCallback((about = false) => {
    navigate((previous) => ({ ...previous, view: "analytics", sheet: undefined }));
    setMessageFocus(undefined);
    setOwner("board");
    setAboutNumbers(about);
  }, [navigate]);
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

  const go = (page: Page) => {
    navigate((previous) => ({ ...previous, view: page, sheet: undefined, productSettings: undefined }));
    setMessageFocus(undefined); setOwner("board"); focusArea.current = page === "board" || page === "history" ? "board" : undefined;
  };
  /** App settings, or a product's editor on Products. */
  const openSettings = (productId?: string) => {
    navigate((previous) => ({ ...previous, view: productId ? "products" : "settings", sheet: undefined, productSettings: productId }));
    setMessageFocus(undefined); setOwner("board");
  };
  const openBoard = (id: string, tab: SheetTab = "overview") => { setOwner("board"); setBoardId(id); open(id, tab, view === "history" ? "history" : "board"); if (tab === "session") setMessageFocus(id); };
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
  const pickProduct = (id: string) => {
    navigate((previous) => ({ ...previous, product: id, view: previous.view === "analytics" ? "analytics" : previous.view === "history" ? "history" : "board", sheet: undefined, productSettings: undefined, history: undefined }));
    setMessageFocus(undefined); setOwner("board");
    if (view === "history") focusArea.current = "board";
  };
  const message = (task: Task) => {
    if (sheet) setSheet({ ...sheet, tab: "session", stepId: undefined });
    else if (area === "inbox" && highlightedItem) openItem(highlightedItem.id, "session");
    else if (area === "board") openBoard(task.id, "session");
    else open(task.id, "session");
    setMessageFocus(task.id);
  };
  const { sendAction, pause, move, place } = taskCommands({ state, find, live: () => status.link === "live", visible, toast });
  const walk = (direction: -1 | 1) => {
    if (area === "board" || sheet?.list === "board") setBoardKeyboard(true);
    if (sheet) {
      if (!sheet.list) { toast("J and K walk the board or the inbox", "Open a task there to walk that list."); return; }
      if (sheet.list === "board" || sheet.list === "history") {
        const id = stepHighlight(boardIds, sheet.taskId, direction, sheetOrder.current);
        if (id) { setBoardId(id); open(id, sheet.tab, sheet.list); }
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
    const el = id ? Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`)).find((node) => node.getAttribute(attr) === id) : area === "inbox" ? inboxPanel.current : document.querySelector<HTMLElement>(view === "history" ? ".history-page" : ".board");
    if (id && !pressing.current) el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Give Tab a starting point at the highlighted item, without taking focus from a field.
    if (el && !palette && !creating && !addingProduct && !rolePanel && !shortcuts && (focusArea.current === area || (!el.contains(document.activeElement) && !isTyping(document.activeElement as HTMLElement)))) {
      el.focus({ preventScroll: true });
      focusArea.current = undefined;
    }
  }, [area, currentBoardId, currentInboxId, palette, creating, addingProduct, rolePanel, shortcuts, history.page]);

  useGlobalKeys({
    palette,
    modal: creating || addingProduct || shortcuts || Boolean(rolePanel),
    sheetOpen: Boolean(sheet),
    area,
    singleKeys,
    focusedTask,
    boardId: currentBoardId,
    inboxId: currentInboxId,
    togglePalette: () => {
      if (creating || addingProduct || rolePanel) return;
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
    go: (page) => { if (page === "board") setBoardKeyboard(true); go(page); },
    showShortcuts: () => setShortcuts(true),
    walk,
    pause,
    message,
  });

  // The palette's task rows stay with the task in focus when it opened, and go if that task does.
  const paletteTask = palette ? detailFind.task(paletteTaskId) : undefined;
  const actions = appActions({ state, singleKeys, newTask: () => newTask(), openInbox, go, showShortcuts: () => setShortcuts(true), sendAction, theme, onTheme: setTheme });
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

      <Rail view={view} blocking={blocking} onGo={go} hrefFor={(page) => routeHref({ ...route, view: page, sheet: undefined, productSettings: undefined })} />
      <main className="main" aria-label={missing ?? PAGE_NAMES[view]}>
        {missing && <div className="page route-missing"><p>This link is unavailable. It may have been removed or the address may be incomplete.</p><button className="btn outline" onClick={() => go("board")}>Go to Board</button></div>}
        {!missing && view === "board" && (
          <Board
            state={state}
            find={find}
            visible={visible}
            selectedId={area === "board" && boardKeyboard ? currentBoardId : undefined}
            onOpen={openBoard}
            onFocus={(id) => { setOwner("board"); if (id) setBoardId(id); }}
            drafts={drafts}
            onPlace={place}
            onNewTask={() => newTask()}
            onShowInbox={openInbox}
            {...(canAddProduct ? { onAddProduct: () => setAddingProduct(true) } : {})}
          />
        )}
        {!missing && view === "history" && <History page={history.page} error={history.error} reload={history.reload} position={route.history} onPosition={setHistoryPosition} find={find} selectedId={area === "board" ? currentBoardId : undefined} onFocus={(id) => { setOwner("board"); if (id) setBoardId(id); }} onOpen={openBoard} hrefFor={(id) => routeHref({ ...route, sheet: { taskId: id, tab: "overview", list: "history" } })} drafts={drafts} />}
        {!missing && view === "products" && (
          <ProductsPage
            state={state}
            settings={productSettings}
            onSettings={setProductSettings}
            {...(canAddProduct ? { onAdd: () => setAddingProduct(true) } : {})}
            onPick={pickProduct}
          />
        )}
        {!missing && view === "agents" && <AgentsPage state={state} find={find} onOpen={open} />}
        {!missing && view === "analytics" && <AnalyticsPage state={state} find={find} product={product} about={aboutNumbers} onAboutSeen={aboutSeen} onOpen={(taskId) => open(taskId)} />}
        {!missing && view === "library" && <LibraryPage state={state} find={find} onRole={setRolePanel} />}
        {!missing && view === "settings" && <SettingsPage onShortcuts={() => setShortcuts(true)} theme={theme} onTheme={setTheme} />}
      </main>

      {inboxOpen ? <Inbox ref={inboxPanel} state={state} find={find} overlay={overlay && !sheet} landing={landing} onOpen={open} onClose={() => closeInbox(false)} selectedId={area === "inbox" ? currentInboxId : undefined} onFocus={(id) => {
        setOwner("inbox");
        if (!id && blankLanding.current) return;
        blankLanding.current = false;
        setInboxId(id ?? currentInboxId ?? inboxIds[0]);
      }} onOpenItem={openItem} /> : <div />}

      {sheet && !sheetTask && (loadingDetails || detailsError) && <TaskLoading error={detailsError} onRetry={() => { setFetchedTask(undefined); setDetailsRetry((value) => value + 1); }} onClose={close} />}

      {sheetTask && sheet && (
        <TaskSheet task={sheetTask} tasks={sheet.list === "history" ? history.page?.items ?? [] : activeBoardIds.flatMap((id) => find.task(id) ? [find.task(id)!] : [])} onTask={openBoard} state={detailState} find={detailFind} tab={sheet.tab} onTab={(tab) => setSheet({ ...sheet, tab, stepId: undefined })} selectedStep={sheet.stepId} onStep={(stepId) => setSheet({ ...sheet, stepId })} draft={draftFor(drafts, sheetTask.id)} onDraft={(text) => setDrafts((all) => withDraft(all, sheetTask.id, text))} messageFocus={messageFocus === sheetTask.id} onMessageFocused={messageFocused} onMessage={() => message(sheetTask)} onClose={close} onToast={(title, detail) => toast(title, detail)} onAboutNumbers={() => analytics(true)} {...(jump?.sheet ? { waiting: jump.line } : {})} />
      )}

      {!missing && rolePanel && <RolePanel key={JSON.stringify(rolePanel)} state={state} target={rolePanel} onClose={() => setRolePanel(undefined)} />}

      <TakeOverDialogs state={state} find={find} onToast={(title, detail) => toast(title, detail)} />

      {addingProduct && (
        <AddProductDialog
          {...(jump ? { waiting: jump.line } : {})}
          onClose={() => setAddingProduct(false)}
          onAdded={(productId) => {
            setAddingProduct(false);
            pickProduct(productId);
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
            if (!sheet) go("board");
          }}
        />
      )}

      {palette && <CommandPalette state={state} actions={actions} taskActions={forTask} onClose={() => setPalette(false)} onTask={(id) => open(id)} onProduct={pickProduct} onHistoryProduct={(id) => { navigate((previous) => ({ ...previous, view: "history", product: id, sheet: undefined, productSettings: undefined, history: undefined })); setMessageFocus(undefined); setOwner("board"); focusArea.current = "board"; }} onNew={newTask} onFilter={(text) => { setQuery(text); go("board"); }} onLimit={(limit) => { void sendAction(() => sim.setPoolLimit(limit), `Pool limit set to ${limit}`, "Lowering the limit never stops anyone."); }} />}
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
