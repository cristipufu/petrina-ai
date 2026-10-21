import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { HISTORY_STATUSES, type HistoryStatus, type Page, type TaskList } from "@petrina/core";
import type { HistoryPosition } from "./components/History";
import type { SheetTab } from "./components/TaskCard";

export const PAGE_NAMES: Record<Page, string> = { board: "Board", history: "History", products: "Products", routines: "Routines", agents: "Agents", analytics: "Analytics", library: "Library", settings: "Settings" };
const TABS: readonly SheetTab[] = ["overview", "plan", "design", "review", "session"];
const OWN_PARAMS = ["product", "from", "node", "historyCursor", "historyQuery", "historyPrevious", "historyStatus", "routine"];

/** Keep the browser's open-in-new-tab and copy-link behaviour. */
export function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

export type TaskRoute = { taskId: string; tab: SheetTab; list: TaskList; itemId?: string; stepId?: string };
export interface AppRoute {
  view: Page;
  product: string;
  sheet?: TaskRoute;
  productSettings?: string;
  libraryView?: "roles" | "profiles";
  history?: HistoryPosition;
  routineRuns?: { id: string; history?: HistoryPosition };
  missing?: string;
}

/** The address is the source of navigation state; dialogs and unsent text stay local. */
export function readRoute(address: URL): AppRoute {
  const base: AppRoute = { view: "board", product: address.searchParams.get("product") || "all" };
  const historyState = () => {
    const cursor = address.searchParams.get("historyCursor") || undefined;
    const query = address.searchParams.get("historyQuery") || undefined;
    const previous = address.searchParams.getAll("historyPrevious");
    const chosenStatus = address.searchParams.get("historyStatus");
    const status = chosenStatus && Object.hasOwn(HISTORY_STATUSES, chosenStatus) ? chosenStatus as HistoryStatus : undefined;
    return cursor || query || status || previous.length ? { history: { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), ...(query ? { query } : {}), ...(previous.length ? { previous } : {}) } } : {};
  };
  let parts: string[];
  try { parts = address.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return { ...base, missing: address.pathname }; }
  if (!parts.length) return base;
  const [page, id, detail, extra] = parts;
  if (page === "tasks" && id && !extra && (!detail || TABS.includes(detail as SheetTab))) {
    const from = address.searchParams.get("from");
    const view = from && Object.hasOwn(PAGE_NAMES, from) ? from as Page : "board";
    const stepId = address.searchParams.get("node");
    return { ...base, view, ...(view === "history" ? historyState() : {}), ...(view === "routines" && address.searchParams.get("routine") ? { routineRuns: { id: address.searchParams.get("routine")!, ...historyState() } } : {}), sheet: { taskId: id, tab: detail as SheetTab || "overview", list: view === "board" ? "board" : view === "history" || view === "routines" && !!address.searchParams.get("routine") ? "history" : undefined, ...(stepId ? { stepId } : {}) } };
  }
  if (page && Object.hasOwn(PAGE_NAMES, page)) {
    const route = { ...base, view: page as Page, ...(page === "history" ? historyState() : {}) };
    if (parts.length === 1) return route;
    if (page === "routines" && id && detail === "runs" && !extra) return { ...route, routineRuns: { id, ...historyState() } };
    if (page === "library" && ["roles", "profiles"].includes(id ?? "") && parts.length === 2) return { ...route, libraryView: id as AppRoute["libraryView"] };
    if (page === "products" && id && detail === "settings" && !extra) return { ...route, productSettings: id };
    // Bookmarks from before product settings moved out of app settings still open their editor.
    if (page === "settings" && id === "products" && detail && !extra) return { ...route, view: "products", productSettings: detail };
  }
  return { ...base, missing: address.pathname };
}

/** Retain mode parameters such as ?demo=portfolio and never put the engine key in a link. */
export function routeHref(route: AppRoute, search = window.location.search): string {
  let path = route.view === "board" ? "/" : `/${route.view}`;
  const query = new URLSearchParams(search);
  for (const key of OWN_PARAMS) query.delete(key);
  if (route.product !== "all") query.set("product", route.product);
  const position = route.view === "history" ? route.history : route.view === "routines" ? route.routineRuns?.history : undefined;
  if (position?.status) query.set("historyStatus", position.status);
  if (position?.cursor) query.set("historyCursor", position.cursor);
  if (position?.query) query.set("historyQuery", position.query);
  if (route.sheet) {
    path = `/tasks/${encodeURIComponent(route.sheet.taskId)}${route.sheet.tab === "overview" ? "" : `/${route.sheet.tab}`}`;
    if (route.view !== "board") query.set("from", route.view);
    if (route.view === "routines" && route.routineRuns) query.set("routine", route.routineRuns.id);
    if (route.sheet.stepId) query.set("node", route.sheet.stepId);
  } else if (route.view === "routines" && route.routineRuns) path += `/${encodeURIComponent(route.routineRuns.id)}/runs`;
  else if (route.view === "library" && route.libraryView) path += `/${route.libraryView}`;
  else if (route.view === "products" && route.productSettings) path += `/${encodeURIComponent(route.productSettings)}/settings`;
  const suffix = query.toString();
  return path + (suffix ? `?${suffix}` : "");
}

export function useAppRoute() {
  const readCurrent = () => {
    const route = readRoute(new URL(window.location.href));
    const previous: unknown = window.history.state?.petrinaHistoryPrevious;
    if (route.view === "history" && Array.isArray(previous) && previous.length && previous.every((cursor) => typeof cursor === "string")) return { ...route, history: { ...route.history, previous: previous.slice(-50) as string[] } };
    if (route.view === "routines" && route.routineRuns && Array.isArray(previous) && previous.every((cursor) => typeof cursor === "string")) return { ...route, routineRuns: { ...route.routineRuns, history: { ...route.routineRuns.history, previous: previous.slice(-50) as string[] } } };
    return route;
  };
  const [route, setRoute] = useState(readCurrent);
  const current = useRef(route);
  const navigate = useCallback((change: (previous: AppRoute) => AppRoute, replace = false) => {
    const next = { ...change(current.current) };
    delete next.missing;
    const href = routeHref(next);
    if (href !== window.location.pathname + window.location.search) {
      window.history[replace ? "replaceState" : "pushState"]({ petrinaHistoryPrevious: (next.view === "history" ? next.history : next.view === "routines" ? next.routineRuns?.history : undefined)?.previous?.slice(-50) ?? [] }, "", href);
    }
    current.current = next;
    setRoute(next);
  }, []);
  useEffect(() => {
    const follow = () => { const next = readCurrent(); current.current = next; setRoute(next); };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  return [route, navigate] as const;
}
