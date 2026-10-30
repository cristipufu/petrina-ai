import type { InboxItem, keyArea, Page, State, Task, TaskList } from "@petrina/core";
import { AddProductDialog } from "./components/AddProduct";
import { AnalyticsPage } from "./components/Analytics";
import { Board } from "./components/Board";
import { CommandPalette, KeyboardShortcuts, taskState, type PaletteAction } from "./components/CommandPalette";
import { CouldNotStart } from "./components/EngineState";
import { History, TaskLoading, type HistoryPosition, type useHistoryPage } from "./components/History";
import { NewTaskDialog } from "./components/NewTask";
import { AgentsPage, LibraryPage } from "./components/Pages";
import { ProductsPage } from "./components/Products";
import { RolePanel, type RolePanelTarget } from "./components/Roles";
import { RoutineRuns } from "./components/RoutineRuns";
import { Routines } from "./components/Routines";
import { SettingsPage } from "./components/Settings";
import { TakeOverDialogs } from "./components/TakeOver";
import type { SheetTab } from "./components/TaskCard";
import { DependencyEditor } from "./components/TaskDependencies";
import { TaskSheet, type TaskListEntry } from "./components/TaskSheet";
import type { TaskDrafts } from "./drafts";
import type { lookup } from "./lib";
import { PAGE_NAMES, routeHref, type AppRoute } from "./routes";
import type { Theme } from "./theme";
import { Toasts, type Toast } from "./toasts";

type Lookup = ReturnType<typeof lookup>;
type HistoryState = ReturnType<typeof useHistoryPage>;
type ActiveArea = ReturnType<typeof keyArea>;

export interface WorkspaceMainContext {
  missing: string | undefined;
  route: AppRoute;
  state: State;
  find: Lookup;
  drafts: Readonly<Record<string, boolean>>;
  canAddProduct: boolean;
  aboutNumbers: boolean;
  theme: Theme;
  visible: (task: Task) => boolean;
}

export interface WorkspaceMainSelection {
  area: ActiveArea;
  boardKeyboard: boolean;
  currentBoardId: string | undefined;
}

export interface WorkspaceMainHistory {
  history: HistoryState;
  runs: AppRoute["routineRuns"];
  currentRuns: readonly Task[];
  runHistory: HistoryState;
}

export interface WorkspaceMainActions {
  onGo: (page: Page) => void;
  onOpenBoard: (id: string, tab?: SheetTab) => void;
  onOpen: (taskId: string, tab?: SheetTab, list?: TaskList, itemId?: string) => void;
  onSetOwnerBoard: () => void;
  onSetBoardId: (id: string) => void;
  onSetDependencyTask: (task: Task | undefined) => void;
  onPlace: (id: string, anchor: string, side: "before" | "after") => void;
  onNewTask: () => void;
  onShowInbox: () => void;
  onAddProduct: () => void;
  onHistoryPosition: (position: HistoryPosition) => void;
  onProductSettings: (next: string | undefined) => void;
  onPickProduct: (id: string) => void;
  onAboutSeen: () => void;
  onRunPosition: (position: HistoryPosition) => void;
  onOpenRoutineRuns: (id: string) => void;
  onRoutineDialog: (open: boolean) => void;
  onRolePanel: (target: RolePanelTarget | undefined) => void;
  onLibraryView: (libraryView: NonNullable<AppRoute["libraryView"]>) => void;
  onShowShortcuts: () => void;
  onTheme: (theme: Theme) => void;
}

export function WorkspaceMain({
  workspace,
  selection,
  historyData,
  actions,
}: {
  workspace: WorkspaceMainContext;
  selection: WorkspaceMainSelection;
  historyData: WorkspaceMainHistory;
  actions: WorkspaceMainActions;
}) {
  const { missing, route, state, find, drafts, canAddProduct, aboutNumbers, theme, visible } = workspace;
  const { area, boardKeyboard, currentBoardId } = selection;
  const { history, runs, currentRuns, runHistory } = historyData;
  const { view, product, productSettings } = route;
  return (
    <main className="main" aria-label={missing ?? PAGE_NAMES[view]}>
      {missing && (
        <div className="page route-missing">
          <p>This link is unavailable. It may have been removed or the address may be incomplete.</p>
          <button className="btn outline" onClick={() => actions.onGo("board")}>
            Go to Board
          </button>
        </div>
      )}
      {!missing && view === "board" && (
        <Board
          state={state}
          find={find}
          visible={visible}
          selectedId={area === "board" && boardKeyboard ? currentBoardId : undefined}
          onOpen={actions.onOpenBoard}
          onDependencies={actions.onSetDependencyTask}
          onFocus={(id) => {
            actions.onSetOwnerBoard();
            if (id) actions.onSetBoardId(id);
          }}
          drafts={drafts}
          onPlace={actions.onPlace}
          onNewTask={actions.onNewTask}
          onShowInbox={actions.onShowInbox}
          {...(canAddProduct ? { onAddProduct: actions.onAddProduct } : {})}
        />
      )}
      {!missing && view === "history" && (
        <History
          page={history.page}
          error={history.error}
          reload={history.reload}
          position={route.history}
          onPosition={actions.onHistoryPosition}
          find={find}
          selectedId={area === "board" ? currentBoardId : undefined}
          onFocus={(id) => {
            actions.onSetOwnerBoard();
            if (id) actions.onSetBoardId(id);
          }}
          onOpen={actions.onOpenBoard}
          hrefFor={(id) =>
            routeHref({
              ...route,
              sheet: { taskId: id, tab: "overview", list: "history" },
            })
          }
          drafts={drafts}
        />
      )}
      {!missing && view === "products" && (
        <ProductsPage
          state={state}
          settings={productSettings}
          onSettings={actions.onProductSettings}
          {...(canAddProduct ? { onAdd: actions.onAddProduct } : {})}
          onPick={actions.onPickProduct}
        />
      )}
      {!missing && view === "agents" && <AgentsPage state={state} find={find} onOpen={actions.onOpen} />}
      {!missing && view === "analytics" && (
        <AnalyticsPage
          state={state}
          find={find}
          product={product}
          about={aboutNumbers}
          onAboutSeen={actions.onAboutSeen}
          onOpen={(taskId) => actions.onOpen(taskId)}
        />
      )}
      {!missing
        && view === "routines"
        && (runs ? (
          <RoutineRuns
            id={runs.id}
            state={state}
            product={product}
            find={find}
            current={currentRuns}
            history={runHistory}
            position={runs.history}
            onPosition={actions.onRunPosition}
            onBack={() => actions.onGo("routines")}
            onOpen={actions.onOpenBoard}
            hrefFor={(id) =>
              routeHref({
                ...route,
                sheet: { taskId: id, tab: "overview", list: "history" },
              })
            }
            drafts={drafts}
          />
        ) : (
          <div className="page">
            <Routines
              state={state}
              find={find}
              product={product}
              onOpen={actions.onOpen}
              onRuns={actions.onOpenRoutineRuns}
              onDialogChange={actions.onRoutineDialog}
            />
          </div>
        ))}
      {!missing && view === "library" && (
        <LibraryPage
          state={state}
          onRole={actions.onRolePanel}
          onEditorDialog={actions.onRoutineDialog}
          product={product}
          view={route.libraryView ?? "roles"}
          onView={actions.onLibraryView}
        />
      )}
      {!missing && view === "settings" && (
        <SettingsPage onShortcuts={actions.onShowShortcuts} theme={theme} onTheme={actions.onTheme} />
      )}
    </main>
  );
}

export interface WorkspaceOverlaysContext {
  state: State;
  find: Lookup;
  detailState: State;
  detailFind: Lookup;
  missing: string | undefined;
  product: string;
  area: ActiveArea;
  focusedTask: Task | undefined;
  highlightedItem: InboxItem | undefined;
  engineFailedProblem: string | undefined;
  toasts: readonly Toast[];
  jump: { line: string; sheet?: boolean } | undefined;
}

export interface WorkspaceOverlaysSheet {
  sheet: AppRoute["sheet"];
  sheetTask: Task | undefined;
  sheetTasks: readonly TaskListEntry[];
  loadingDetails: boolean;
  detailsError: string | undefined;
  drafts: Readonly<Record<string, boolean>>;
  draftStore: TaskDrafts;
  messageFocus: string | undefined;
}

export interface WorkspaceOverlaysDialogs {
  rolePanel: RolePanelTarget | undefined;
  addingProduct: boolean;
  creating: boolean;
  newTitle: string;
  palette: boolean;
  actions: PaletteAction[];
  forTask: PaletteAction[];
  shortcuts: boolean;
  dependencyTask: Task | undefined;
}

export interface WorkspaceOverlaysHandlers {
  onRetryDetails: () => void;
  onCloseSheet: () => void;
  onOpenBoard: (id: string, tab?: SheetTab) => void;
  onOpenLinked: (id: string) => void;
  onSetDependencyTask: (task: Task | undefined) => void;
  onSheetChange: (next: AppRoute["sheet"]) => void;
  onMessageFocused: () => void;
  onMessage: (task: Task) => void;
  onToast: (title: string, detail?: string) => void;
  onAboutNumbers: () => void;
  onCloseRolePanel: () => void;
  onCloseAddProduct: () => void;
  onProductAdded: (productId: string) => void;
  onCloseCreating: () => void;
  onTaskCreated: () => void;
  onClosePalette: () => void;
  onOpenTask: (id: string) => void;
  onPickProduct: (id: string) => void;
  onHistoryProduct: (id: string) => void;
  onNewTask: (title?: string) => void;
  onFilter: (text: string) => void;
  onPoolLimit: (limit: number) => void;
  onCloseShortcuts: () => void;
  onViewToast: (entry: Toast) => void;
}

export function WorkspaceOverlays({
  workspace,
  sheetView,
  dialogs,
  handlers,
}: {
  workspace: WorkspaceOverlaysContext;
  sheetView: WorkspaceOverlaysSheet;
  dialogs: WorkspaceOverlaysDialogs;
  handlers: WorkspaceOverlaysHandlers;
}) {
  const {
    state,
    find,
    detailState,
    detailFind,
    missing,
    product,
    area,
    focusedTask,
    highlightedItem,
    engineFailedProblem,
    toasts,
    jump,
  } = workspace;
  const { sheet, sheetTask, sheetTasks, loadingDetails, detailsError, drafts, draftStore, messageFocus } = sheetView;
  const { rolePanel, addingProduct, creating, newTitle, palette, actions, forTask, shortcuts, dependencyTask } =
    dialogs;

  return (
    <>
      {sheet && !sheetTask && (loadingDetails || detailsError) && (
        <TaskLoading error={detailsError} onRetry={handlers.onRetryDetails} onClose={handlers.onCloseSheet} />
      )}

      {sheetTask && sheet && (
        <TaskSheet
          task={sheetTask}
          tasks={sheetTasks}
          onTask={handlers.onOpenBoard}
          onOpenTask={handlers.onOpenLinked}
          onDependencies={handlers.onSetDependencyTask}
          state={detailState}
          find={detailFind}
          tab={sheet.tab}
          onTab={(tab) => handlers.onSheetChange({ ...sheet, tab, stepId: undefined })}
          selectedStep={sheet.stepId}
          selectedAttempt={sheet.attemptId}
          onStep={(stepId, attemptId) => handlers.onSheetChange({ ...sheet, stepId, attemptId })}
          hasDraft={Boolean(drafts[sheetTask.id])}
          drafts={draftStore}
          messageFocus={messageFocus === sheetTask.id}
          onMessageFocused={handlers.onMessageFocused}
          onMessage={() => handlers.onMessage(sheetTask)}
          onClose={handlers.onCloseSheet}
          onToast={handlers.onToast}
          onAboutNumbers={handlers.onAboutNumbers}
          {...(jump?.sheet ? { waiting: jump.line } : {})}
        />
      )}

      {!missing && rolePanel && (
        <RolePanel key={JSON.stringify(rolePanel)} state={state} target={rolePanel} onClose={handlers.onCloseRolePanel} />
      )}

      <TakeOverDialogs state={state} find={find} onToast={handlers.onToast} />

      {addingProduct && (
        <AddProductDialog
          {...(jump ? { waiting: jump.line } : {})}
          onClose={handlers.onCloseAddProduct}
          onAdded={handlers.onProductAdded}
        />
      )}

      {creating && (
        <NewTaskDialog
          state={state}
          initialTitle={newTitle}
          {...(jump ? { waiting: jump.line } : {})}
          {...(product !== "all" ? { defaultProduct: product } : {})}
          onClose={handlers.onCloseCreating}
          onCreated={handlers.onTaskCreated}
        />
      )}

      {palette && (
        <CommandPalette
          state={state}
          actions={actions}
          taskActions={forTask}
          onClose={handlers.onClosePalette}
          onTask={handlers.onOpenTask}
          onProduct={handlers.onPickProduct}
          onHistoryProduct={handlers.onHistoryProduct}
          onNew={handlers.onNewTask}
          onFilter={handlers.onFilter}
          onLimit={handlers.onPoolLimit}
        />
      )}

      {shortcuts && <KeyboardShortcuts onClose={handlers.onCloseShortcuts} />}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {focusedTask
          ? `${focusedTask.title}, ${taskState(focusedTask, state)}${area === "inbox" && highlightedItem ? `, ${highlightedItem.title}` : ""}`
          : ""}
      </div>

      {engineFailedProblem !== undefined && <CouldNotStart problem={engineFailedProblem} />}

      <Toasts toasts={toasts} onView={handlers.onViewToast} />

      {dependencyTask && (
        <DependencyEditor
          task={find.task(dependencyTask.id) ?? { ...dependencyTask, state: "done" }}
          state={state}
          onClose={() => handlers.onSetDependencyTask(undefined)}
          onOpenTask={(id) => {
            handlers.onSetDependencyTask(undefined);
            handlers.onOpenLinked(id);
          }}
        />
      )}
    </>
  );
}
