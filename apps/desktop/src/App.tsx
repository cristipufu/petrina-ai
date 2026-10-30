import {
  boardOrder,
  inboxOrder,
  inboxTab,
  involvesProduct,
  keyArea,
  matchesWords,
  reconcileHighlight,
  taskProductIds,
  type KeyArea,
  type Page,
  type State,
  type Task,
  type TaskList,
} from "@petrina/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useViewport, viewportSize } from "./components/bits";
import { CouldNotStart, EngineRecovery, StartingScreen } from "./components/EngineState";
import { FirstRun } from "./components/FirstRun";
import type { HistoryPosition } from "./components/History";
import { Inbox } from "./components/Inbox";
import { Rail } from "./components/Rail";
import type { RolePanelTarget } from "./components/Roles";
import type { SheetTab } from "./components/TaskCard";
import { TopBar } from "./components/TopBar";
import { TaskDrafts } from "./drafts";
import { mode, sim, useEngineStatus, useSim, type EngineStatus } from "./engine";
import { useSingleKeys } from "./keyboard";
import { blockingCount, lookup } from "./lib";
import { useLanding } from "./notify/useLanding";
import { useNotices } from "./notify/useNotices";
import type { Notice } from "./notify/words";
import { routeHref, useAppRoute } from "./routes";
import { taskCommands } from "./taskCommands";
import { initialTheme, type Theme } from "./theme";
import { useToasts } from "./toasts";
import { useWorkspaceFocus } from "./useWorkspaceFocus";
import { useWorkspaceSheetState } from "./useWorkspaceSheetState";
import { WorkspaceMain, WorkspaceOverlays } from "./WorkspaceViews";

// The app's frame: which page shows, the board and inbox highlights and focus, the task sheet and the
// dialogs. The top bar, the rail, the keyboard, the palette's actions, notification landings and toasts
// each live in a module of their own.

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
  const find = useMemo(
    () => lookup(state),
    [
      state.roles,
      state.profiles,
      state.retiredProfiles,
      state.tools,
      state.products,
      state.tasks,
      state.history?.dependencies,
    ],
  );
  const viewport = useViewport();
  const [route, navigate] = useAppRoute();
  const { view, product, sheet, productSettings } = route;
  const productSettingsOpen = view === "products" && Boolean(productSettings && find.product(productSettings));
  const setSheet = useCallback((next: typeof sheet) => navigate((previous) => ({ ...previous, sheet: next })), [navigate]);
  const [rolePanel, setRolePanel] = useState<RolePanelTarget>();
  const [routineDialog, setRoutineDialog] = useState(false);
  const setProductSettings = (next: string | undefined) =>
    navigate((previous) => ({ ...previous, view: "products", productSettings: next }));
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

  const {
    history,
    runs,
    runHistory,
    currentRuns,
    runTasks,
    retainedHistoryIds,
    sheetTask,
    loadingDetails,
    detailsError,
    detailState,
    detailFind,
    missing,
    retryDetails,
  } = useWorkspaceSheetState(state, route, find);

  const setRunPosition = (position: HistoryPosition) =>
    navigate((previous) => ({
      ...previous,
      routineRuns: previous.routineRuns ? { ...previous.routineRuns, history: position } : undefined,
      sheet: undefined,
    }));
  const setHistoryPosition = (position: HistoryPosition) =>
    navigate((previous) => ({ ...previous, history: position, sheet: undefined }));

  const [draftStore] = useState(() => new TaskDrafts());
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.presence);
  const [messageFocus, setMessageFocus] = useState<string>();
  const messageFocused = useCallback(() => setMessageFocus(undefined), []);
  const [newTitle, setNewTitle] = useState("");
  const [inboxOpen, setInboxOpen] = useState(() => viewportSize().width >= DOCKED_INBOX);
  const [creating, setCreating] = useState(false);
  const [dependencyTask, setDependencyTask] = useState<Task>();
  const [addingProduct, setAddingProduct] = useState(false);
  // The engine adds any clone. Of the demos, only first run's has clones to add, Skip setup included.
  const canAddProduct = mode === "engine" || state.setup !== undefined;
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const inboxButton = useRef<HTMLButtonElement>(null);
  const inboxPanel = useRef<HTMLElement>(null);
  const focusArea = useRef<KeyArea | undefined>(undefined);
  const { toasts, showToast, toast, dismiss } = useToasts();
  const modalWithoutShortcuts =
    creating || addingProduct || Boolean(rolePanel) || Boolean(dependencyTask) || routineDialog || productSettingsOpen;
  // Read by notification clicks, which arrive outside React's renders.
  const latest = useRef({ state, dialog: modalWithoutShortcuts, sheet: sheet !== undefined });
  latest.current = { state, dialog: modalWithoutShortcuts, sheet: sheet !== undefined };

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

  useEffect(() => {
    if (!route.missing && product !== "all" && !state.products.some((entry) => entry.id === product)) {
      navigate((previous) => ({ ...previous, product: "all" }), true);
    }
  }, [state.products, product, route.missing, navigate]);

  const visible = useCallback(
    (task: Task) =>
      (product === "all" || involvesProduct(task, product))
      && matchesWords(query, task.title, ...taskProductIds(task).map((id) => find.product(id)?.name ?? "")),
    [product, query, find],
  );
  const activeBoardIds = useMemo(() => boardOrder(state.tasks, visible, false), [state.tasks, visible]);
  const boardIds = view === "history" ? retainedHistoryIds : runs ? runTasks.map((task) => task.id) : activeBoardIds;
  const items = useMemo(() => inboxOrder(state), [state.inbox, state.tasks]);
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
  useEffect(() => {
    setBoardId(currentBoardId);
    previousBoard.current = boardIds;
  }, [currentBoardId, boardIds]);
  useEffect(() => {
    setInboxId(currentInboxId);
    previousInbox.current = inboxIds;
  }, [currentInboxId, inboxIds]);
  const area = keyArea(view, inboxOpen, owner, Boolean(sheet));
  const highlightedItem = items.find((item) => item.id === currentInboxId);
  const focusedTask =
    sheetTask ?? (area === "inbox" ? find.task(highlightedItem?.taskId) : area === "board" ? find.task(currentBoardId) : undefined);
  const [paletteTaskId, setPaletteTaskId] = useState<string>();
  const openPalette = () => {
    setPaletteTaskId(focusedTask?.id);
    setPalette(true);
  };

  const open = useCallback(
    (taskId: string, tab: SheetTab = "overview", list?: TaskList, itemId?: string) => {
      sheetOrder.current = list === "board" || list === "history" ? boardIds : list === "inbox" ? inboxIds : [];
      setMessageFocus(undefined);
      setSheet({ taskId, tab, list, ...(itemId ? { itemId } : {}) });
    },
    [boardIds, inboxIds, setSheet],
  );
  const close = useCallback(() => {
    setSheet(undefined);
    setMessageFocus(undefined);
  }, [setSheet]);
  /** Go to Analytics, optionally with "About these numbers" open. */
  const analytics = useCallback(
    (about = false) => {
      navigate((previous) => ({ ...previous, view: "analytics", sheet: undefined }));
      setMessageFocus(undefined);
      setOwner("board");
      setAboutNumbers(about);
    },
    [navigate],
  );
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
  const { jump, landing, requestJump, blankLanding } = useLanding({
    latest,
    inboxPanel,
    closeSheet: close,
    closeOverlays,
    openInboxAt,
  });

  const toastNotice = useCallback((notice: Notice) => showToast(notice.title, notice.lines, notice.target), [showToast]);
  useNotices({ onJump: requestJump, onToast: toastNotice });

  const go = (page: Page) => {
    navigate((previous) => ({
      ...previous,
      view: page,
      sheet: undefined,
      productSettings: undefined,
      routineRuns: undefined,
    }));
    setMessageFocus(undefined);
    setOwner("board");
    focusArea.current = page === "board" || page === "history" ? "board" : undefined;
  };
  /** App settings, or a product's editor on Products. */
  const openSettings = (productId?: string) => {
    navigate((previous) => ({
      ...previous,
      view: productId ? "products" : "settings",
      sheet: undefined,
      productSettings: productId,
    }));
    setMessageFocus(undefined);
    setOwner("board");
  };
  const openBoard = (id: string, tab: SheetTab = "overview") => {
    setOwner("board");
    setBoardId(id);
    open(id, tab, view === "history" || runs ? "history" : "board");
    if (tab === "session") setMessageFocus(id);
  };
  const openLinked = useCallback(
    (taskId: string) => {
      const known = find.task(taskId);
      const finished = !known || known.state === "done" || known.state === "cancelled";
      const nextView = finished ? "history" : "board";
      setOwner("board");
      setBoardId(taskId);
      setMessageFocus(undefined);
      navigate((previous) => ({ ...previous, view: nextView, sheet: { taskId, tab: "overview", list: nextView } }));
    },
    [find, navigate],
  );
  const openItem = (id: string, tab?: SheetTab) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    setOwner("inbox");
    setInboxId(id);
    open(item.taskId, tab ?? inboxTab(item.kind), "inbox", id);
  };
  const openInbox = () => {
    close();
    setInboxOpen(true);
    setOwner("inbox");
    setInboxId(inboxIds[0]);
    blankLanding.current = false;
    focusArea.current = "inbox";
  };
  const closeInbox = (keepButton: boolean) => {
    focusArea.current = !keepButton && view === "board" ? "board" : undefined;
    setInboxOpen(false);
    setOwner("board");
    inboxButton.current?.focus();
  };
  const inboxKey = () => {
    close();
    if (inboxOpen && owner === "inbox") closeInbox(false);
    else openInbox();
  };
  const newTask = (title = "") => {
    setNewTitle(title);
    setCreating(true);
  };
  const pickProduct = (id: string) => {
    navigate((previous) => ({
      ...previous,
      product: id,
      view:
        previous.view === "analytics" || previous.view === "history" || previous.view === "routines"
          ? previous.view
          : "board",
      sheet: undefined,
      productSettings: undefined,
      history: undefined,
      routineRuns: previous.routineRuns ? { id: previous.routineRuns.id } : undefined,
    }));
    setMessageFocus(undefined);
    setOwner("board");
    if (view === "history") focusArea.current = "board";
  };
  const message = (task: Task) => {
    if (sheet) setSheet({ ...sheet, tab: "session", stepId: undefined });
    else if (area === "inbox" && highlightedItem) openItem(highlightedItem.id, "session");
    else if (area === "board") openBoard(task.id, "session");
    else open(task.id, "session");
    setMessageFocus(task.id);
  };
  const { sendAction, pause, move, place } = taskCommands({
    state,
    find,
    live: () => status.link === "live",
    visible,
    toast,
  });
  // The palette's task rows stay with the task in focus when it opened, and go if that task does.
  const paletteTask = palette ? detailFind.task(paletteTaskId) : undefined;
  const { actions, forTask } = useWorkspaceFocus({
    state,
    layout: { theme, onTheme: setTheme, area, view, overlay, sheet },
    lists: {
      boardIds,
      inboxIds,
      currentBoardId,
      currentInboxId,
      sheetOrder,
      focusArea,
      inboxButton,
      inboxPanel,
      historyPage: history.page,
      visible,
    },
    dialogs: { palette, paletteTask, shortcuts, modalWithoutShortcuts, singleKeys, focusedTask },
    setters: { setBoardKeyboard, setBoardId, setInboxId, setOwner, setPalette, setShortcuts, setMessageFocus },
    commands: {
      sendAction,
      openPalette,
      open,
      openBoard: (id) => openBoard(id),
      openItem: (id) => openItem(id),
      openInbox,
      closeSheet: close,
      closeInbox,
      inboxKey,
      newTask: () => newTask(),
      openSettings: () => openSettings(),
      move,
      go,
      pause,
      message,
      toast,
    },
  });
  const blocking = blockingCount(state);
  const docked = inboxOpen && !overlay;
  const recovery = mode === "engine" && !status.desktop && status.link !== "live" && status.recovery;
  const sheetTasks =
    runs && sheet?.list === "history"
      ? runTasks
      : sheet?.list === "history"
        ? (history.page?.items ?? [])
        : activeBoardIds.flatMap((id) => (find.task(id) ? [find.task(id)!] : []));

  return (
    <div
      className={`app ${recovery ? "with-engine-hint" : ""}`}
      style={{ gridTemplateColumns: `var(--rail) minmax(0, 1fr) ${docked ? "auto" : "0px"}` }}
    >
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

      <Rail
        view={view}
        blocking={blocking}
        onGo={go}
        hrefFor={(page) =>
          routeHref({
            ...route,
            view: page,
            sheet: undefined,
            productSettings: undefined,
            routineRuns: undefined,
          })
        }
      />
      <WorkspaceMain
        workspace={{ missing, route, state, find, drafts, canAddProduct, aboutNumbers, theme, visible }}
        selection={{ area, boardKeyboard, currentBoardId }}
        historyData={{ history, runs, currentRuns, runHistory }}
        actions={{
          onGo: go,
          onOpenBoard: openBoard,
          onOpen: open,
          onSetOwnerBoard: () => setOwner("board"),
          onSetBoardId: setBoardId,
          onSetDependencyTask: setDependencyTask,
          onPlace: place,
          onNewTask: () => newTask(),
          onShowInbox: openInbox,
          onAddProduct: () => setAddingProduct(true),
          onHistoryPosition: setHistoryPosition,
          onProductSettings: setProductSettings,
          onPickProduct: pickProduct,
          onAboutSeen: aboutSeen,
          onRunPosition: setRunPosition,
          onOpenRoutineRuns: (id) => navigate((previous) => ({ ...previous, routineRuns: { id }, sheet: undefined })),
          onRoutineDialog: setRoutineDialog,
          onRolePanel: setRolePanel,
          onLibraryView: (libraryView) => navigate((previous) => ({ ...previous, libraryView })),
          onShowShortcuts: () => setShortcuts(true),
          onTheme: setTheme,
        }}
      />

      {inboxOpen ? (
        <Inbox
          ref={inboxPanel}
          state={state}
          find={find}
          overlay={overlay && !sheet}
          landing={landing}
          onOpen={open}
          onClose={() => closeInbox(false)}
          selectedId={area === "inbox" ? currentInboxId : undefined}
          onFocus={(id) => {
            setOwner("inbox");
            if (!id && blankLanding.current) return;
            blankLanding.current = false;
            setInboxId(id ?? currentInboxId ?? inboxIds[0]);
          }}
          onOpenItem={openItem}
        />
      ) : (
        <div />
      )}

      <WorkspaceOverlays
        workspace={{
          state,
          find,
          detailState,
          detailFind,
          missing,
          product,
          area,
          focusedTask,
          highlightedItem,
          engineFailedProblem: mode === "engine" && status.link === "failed" ? (status.problem ?? "") : undefined,
          toasts,
          jump,
        }}
        sheetView={{
          sheet,
          sheetTask,
          sheetTasks,
          loadingDetails,
          detailsError,
          drafts,
          draftStore,
          messageFocus,
        }}
        dialogs={{
          rolePanel,
          addingProduct,
          creating,
          newTitle,
          palette,
          actions,
          forTask,
          shortcuts,
          dependencyTask,
        }}
        handlers={{
          onRetryDetails: retryDetails,
          onCloseSheet: close,
          onOpenBoard: openBoard,
          onOpenLinked: openLinked,
          onSetDependencyTask: setDependencyTask,
          onSheetChange: setSheet,
          onMessageFocused: messageFocused,
          onMessage: message,
          onToast: (title, detail) => toast(title, detail),
          onAboutNumbers: () => analytics(true),
          onCloseRolePanel: () => setRolePanel(undefined),
          onCloseAddProduct: () => setAddingProduct(false),
          onProductAdded: (productId) => {
            setAddingProduct(false);
            pickProduct(productId);
          },
          onCloseCreating: () => setCreating(false),
          onTaskCreated: () => {
            setCreating(false);
            if (!sheet) go("board");
          },
          onClosePalette: () => setPalette(false),
          onOpenTask: (id) => open(id),
          onPickProduct: pickProduct,
          onHistoryProduct: (id) => {
            navigate((previous) => ({
              ...previous,
              view: "history",
              product: id,
              sheet: undefined,
              productSettings: undefined,
              history: undefined,
            }));
            setMessageFocus(undefined);
            setOwner("board");
            focusArea.current = "board";
          },
          onNewTask: newTask,
          onFilter: (text) => {
            setQuery(text);
            go("board");
          },
          onPoolLimit: (limit) => {
            void sendAction(
              () => sim.setPoolLimit(limit),
              `Pool limit set to ${limit}`,
              "Lowering the limit never stops anyone.",
            );
          },
          onCloseShortcuts: () => setShortcuts(false),
          onViewToast: (entry) => {
            dismiss(entry.id);
            if (entry.target) requestJump(entry.target);
          },
        }}
      />
    </div>
  );
}
