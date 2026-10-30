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

export function WorkspaceMain({
  missing,
  route,
  state,
  find,
  area,
  boardKeyboard,
  currentBoardId,
  drafts,
  canAddProduct,
  aboutNumbers,
  history,
  runs,
  currentRuns,
  runHistory,
  theme,
  visible,
  onGo,
  onOpenBoard,
  onOpen,
  onSetOwnerBoard,
  onSetBoardId,
  onSetDependencyTask,
  onPlace,
  onNewTask,
  onShowInbox,
  onAddProduct,
  onHistoryPosition,
  onProductSettings,
  onPickProduct,
  onAboutSeen,
  onRunPosition,
  onOpenRoutineRuns,
  onRoutineDialog,
  onRolePanel,
  onLibraryView,
  onShowShortcuts,
  onTheme,
}: {
  missing: string | undefined;
  route: AppRoute;
  state: State;
  find: Lookup;
  area: ActiveArea;
  boardKeyboard: boolean;
  currentBoardId: string | undefined;
  drafts: Readonly<Record<string, boolean>>;
  canAddProduct: boolean;
  aboutNumbers: boolean;
  history: HistoryState;
  runs: AppRoute["routineRuns"];
  currentRuns: readonly Task[];
  runHistory: HistoryState;
  theme: Theme;
  visible: (task: Task) => boolean;
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
}) {
  const { view, product, productSettings } = route;
  return (
    <main className="main" aria-label={missing ?? PAGE_NAMES[view]}>
      {missing && (
        <div className="page route-missing">
          <p>This link is unavailable. It may have been removed or the address may be incomplete.</p>
          <button className="btn outline" onClick={() => onGo("board")}>
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
          onOpen={onOpenBoard}
          onDependencies={onSetDependencyTask}
          onFocus={(id) => {
            onSetOwnerBoard();
            if (id) onSetBoardId(id);
          }}
          drafts={drafts}
          onPlace={onPlace}
          onNewTask={onNewTask}
          onShowInbox={onShowInbox}
          {...(canAddProduct ? { onAddProduct } : {})}
        />
      )}
      {!missing && view === "history" && (
        <History
          page={history.page}
          error={history.error}
          reload={history.reload}
          position={route.history}
          onPosition={onHistoryPosition}
          find={find}
          selectedId={area === "board" ? currentBoardId : undefined}
          onFocus={(id) => {
            onSetOwnerBoard();
            if (id) onSetBoardId(id);
          }}
          onOpen={onOpenBoard}
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
          onSettings={onProductSettings}
          {...(canAddProduct ? { onAdd: onAddProduct } : {})}
          onPick={onPickProduct}
        />
      )}
      {!missing && view === "agents" && <AgentsPage state={state} find={find} onOpen={onOpen} />}
      {!missing && view === "analytics" && (
        <AnalyticsPage
          state={state}
          find={find}
          product={product}
          about={aboutNumbers}
          onAboutSeen={onAboutSeen}
          onOpen={(taskId) => onOpen(taskId)}
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
            onPosition={onRunPosition}
            onBack={() => onGo("routines")}
            onOpen={onOpenBoard}
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
              onOpen={onOpen}
              onRuns={onOpenRoutineRuns}
              onDialogChange={onRoutineDialog}
            />
          </div>
        ))}
      {!missing && view === "library" && (
        <LibraryPage
          state={state}
          onRole={onRolePanel}
          onEditorDialog={onRoutineDialog}
          product={product}
          view={route.libraryView ?? "roles"}
          onView={onLibraryView}
        />
      )}
      {!missing && view === "settings" && (
        <SettingsPage onShortcuts={onShowShortcuts} theme={theme} onTheme={onTheme} />
      )}
    </main>
  );
}

export function WorkspaceOverlays({
  state,
  find,
  detailState,
  detailFind,
  missing,
  product,
  sheet,
  sheetTask,
  sheetTasks,
  loadingDetails,
  detailsError,
  drafts,
  draftStore,
  messageFocus,
  jump,
  rolePanel,
  addingProduct,
  creating,
  newTitle,
  palette,
  actions,
  forTask,
  shortcuts,
  focusedTask,
  area,
  highlightedItem,
  engineFailedProblem,
  toasts,
  dependencyTask,
  onRetryDetails,
  onCloseSheet,
  onOpenBoard,
  onOpenLinked,
  onSetDependencyTask,
  onSheetChange,
  onMessageFocused,
  onMessage,
  onToast,
  onAboutNumbers,
  onCloseRolePanel,
  onCloseAddProduct,
  onProductAdded,
  onCloseCreating,
  onTaskCreated,
  onClosePalette,
  onOpenTask,
  onPickProduct,
  onHistoryProduct,
  onNewTask,
  onFilter,
  onPoolLimit,
  onCloseShortcuts,
  onViewToast,
}: {
  state: State;
  find: Lookup;
  detailState: State;
  detailFind: Lookup;
  missing: string | undefined;
  product: string;
  sheet: AppRoute["sheet"];
  sheetTask: Task | undefined;
  sheetTasks: readonly TaskListEntry[];
  loadingDetails: boolean;
  detailsError: string | undefined;
  drafts: Readonly<Record<string, boolean>>;
  draftStore: TaskDrafts;
  messageFocus: string | undefined;
  jump: { line: string; sheet?: boolean } | undefined;
  rolePanel: RolePanelTarget | undefined;
  addingProduct: boolean;
  creating: boolean;
  newTitle: string;
  palette: boolean;
  actions: PaletteAction[];
  forTask: PaletteAction[];
  shortcuts: boolean;
  focusedTask: Task | undefined;
  area: ActiveArea;
  highlightedItem: InboxItem | undefined;
  engineFailedProblem: string | undefined;
  toasts: readonly Toast[];
  dependencyTask: Task | undefined;
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
}) {
  return (
    <>
      {sheet && !sheetTask && (loadingDetails || detailsError) && (
        <TaskLoading error={detailsError} onRetry={onRetryDetails} onClose={onCloseSheet} />
      )}

      {sheetTask && sheet && (
        <TaskSheet
          task={sheetTask}
          tasks={sheetTasks}
          onTask={onOpenBoard}
          onOpenTask={onOpenLinked}
          onDependencies={onSetDependencyTask}
          state={detailState}
          find={detailFind}
          tab={sheet.tab}
          onTab={(tab) => onSheetChange({ ...sheet, tab, stepId: undefined })}
          selectedStep={sheet.stepId}
          selectedAttempt={sheet.attemptId}
          onStep={(stepId, attemptId) => onSheetChange({ ...sheet, stepId, attemptId })}
          hasDraft={Boolean(drafts[sheetTask.id])}
          drafts={draftStore}
          messageFocus={messageFocus === sheetTask.id}
          onMessageFocused={onMessageFocused}
          onMessage={() => onMessage(sheetTask)}
          onClose={onCloseSheet}
          onToast={onToast}
          onAboutNumbers={onAboutNumbers}
          {...(jump?.sheet ? { waiting: jump.line } : {})}
        />
      )}

      {!missing && rolePanel && (
        <RolePanel key={JSON.stringify(rolePanel)} state={state} target={rolePanel} onClose={onCloseRolePanel} />
      )}

      <TakeOverDialogs state={state} find={find} onToast={onToast} />

      {addingProduct && (
        <AddProductDialog
          {...(jump ? { waiting: jump.line } : {})}
          onClose={onCloseAddProduct}
          onAdded={onProductAdded}
        />
      )}

      {creating && (
        <NewTaskDialog
          state={state}
          initialTitle={newTitle}
          {...(jump ? { waiting: jump.line } : {})}
          {...(product !== "all" ? { defaultProduct: product } : {})}
          onClose={onCloseCreating}
          onCreated={onTaskCreated}
        />
      )}

      {palette && (
        <CommandPalette
          state={state}
          actions={actions}
          taskActions={forTask}
          onClose={onClosePalette}
          onTask={onOpenTask}
          onProduct={onPickProduct}
          onHistoryProduct={onHistoryProduct}
          onNew={onNewTask}
          onFilter={onFilter}
          onLimit={onPoolLimit}
        />
      )}

      {shortcuts && <KeyboardShortcuts onClose={onCloseShortcuts} />}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {focusedTask
          ? `${focusedTask.title}, ${taskState(focusedTask, state)}${area === "inbox" && highlightedItem ? `, ${highlightedItem.title}` : ""}`
          : ""}
      </div>

      {engineFailedProblem !== undefined && <CouldNotStart problem={engineFailedProblem} />}

      <Toasts toasts={toasts} onView={onViewToast} />

      {dependencyTask && (
        <DependencyEditor
          task={find.task(dependencyTask.id) ?? { ...dependencyTask, state: "done" }}
          state={state}
          onClose={() => onSetDependencyTask(undefined)}
          onOpenTask={(id) => {
            onSetDependencyTask(undefined);
            onOpenLinked(id);
          }}
        />
      )}
    </>
  );
}
