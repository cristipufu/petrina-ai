import { involvesProduct, type State, type Task } from "@petrina/core";
import { useMemo, useRef, useState } from "react";
import { useHistoryPage } from "./components/History";
import { lookup, type Lookup } from "./lib";
import type { AppRoute } from "./routes";
import { useTaskDetails } from "./task-details";

export function useWorkspaceSheetState(state: State, route: AppRoute, find: Lookup) {
  const { view, product, sheet, productSettings } = route;
  const history = useHistoryPage(state, view === "history", product, route.history, { includeUsage: true });
  const runs = view === "routines" ? route.routineRuns : undefined;
  const runHistory = useHistoryPage(state, !!runs, product, runs?.history, { routineId: runs?.id });
  const currentRuns = useMemo(
    () =>
      runs
        ? state.tasks
            .filter(
              (task) =>
                task.maintenance?.routineId === runs.id
                && task.state !== "done"
                && task.state !== "cancelled"
                && (product === "all" || involvesProduct(task, product)),
            )
            .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        : [],
    [runs?.id, state.tasks, product],
  );
  const runTasks = useMemo(() => [...currentRuns, ...(runHistory.page?.items ?? [])], [currentRuns, runHistory.page]);
  const historyIds = useMemo(() => history.page?.items.map((task) => task.id) ?? [], [history.page]);
  const lastHistoryIds = useRef<readonly string[]>([]);
  if (history.page) lastHistoryIds.current = historyIds;

  const [detailsRetry, setDetailsRetry] = useState(0);
  const liveSheetTask = sheet ? find.task(sheet.taskId) : undefined;
  const wantedTaskId = sheet?.taskId;
  const needsDetails = !liveSheetTask || liveSheetTask.detailsOmitted === true;
  const fetchedTask = useTaskDetails(
    wantedTaskId,
    needsDetails,
    liveSheetTask?.detailsRevision,
    state.history?.revision,
    !liveSheetTask,
    detailsRetry,
  );
  const sheetTask: Task | undefined = !needsDetails
    ? liveSheetTask
    : fetchedTask?.id === wantedTaskId
      ? fetchedTask?.task
      : undefined;
  const loadingDetails = Boolean(sheet && !sheetTask && fetchedTask?.id !== wantedTaskId);
  const detailsError = !sheetTask && fetchedTask?.id === wantedTaskId ? fetchedTask?.error : undefined;

  // Only the open historical task joins this view of the sheet. The board and Analytics keep the engine projection.
  const detailTasks = useMemo(
    () =>
      sheetTask && sheetTask !== liveSheetTask
        ? [...state.tasks.filter((task) => task.id !== sheetTask.id), sheetTask]
        : state.tasks,
    [state.tasks, sheetTask, liveSheetTask],
  );
  const detailState = useMemo(
    () => (detailTasks === state.tasks ? state : { ...state, tasks: detailTasks }),
    [state, detailTasks],
  );
  const detailFind = useMemo(
    () => lookup(detailState, sheetTask),
    [
      sheetTask?.maintenance,
      sheetTask?.direct,
      detailState.roles,
      detailState.profiles,
      detailState.retiredProfiles,
      detailState.tools,
      detailState.products,
      detailState.tasks,
      detailState.history?.dependencies,
    ],
  );
  const missing = route.missing
    ? "Page not found"
    : sheet && !sheetTask && !loadingDetails && !detailsError
      ? "Task not found"
      : productSettings && !find.product(productSettings)
        ? "Product not found"
        : undefined;

  return {
    history,
    runs,
    runHistory,
    currentRuns,
    runTasks,
    historyIds,
    retainedHistoryIds: history.page ? historyIds : lastHistoryIds.current,
    sheetTask,
    loadingDetails,
    detailsError,
    detailState,
    detailFind,
    missing,
    retryDetails: () => setDetailsRetry((value) => value + 1),
  };
}
