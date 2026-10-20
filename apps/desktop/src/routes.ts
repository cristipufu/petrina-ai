import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { Page, TaskList } from "@petrina/core";
import type { SheetTab } from "./components/TaskCard";

export const PAGE_NAMES: Record<Page, string> = { board: "Board", history: "History", products: "Products", agents: "Agents", analytics: "Analytics", library: "Library", settings: "Settings" };
const TABS: readonly SheetTab[] = ["overview", "plan", "design", "review", "session"];
const OWN_PARAMS = ["product", "from", "node", "historyCursor", "historyQuery", "historyPrevious"];

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
  libraryView?: "routines" | "roles" | "profiles";
  history?: { cursor?: string; query?: string; previous?: readonly string[] };
  missing?: string;
}

/** The address is the source of navigation state; dialogs and unsent text stay local. */
export function readRoute(address: URL): AppRoute {
  const base: AppRoute = { view: "board", product: address.searchParams.get("product") || "all" };
  const historyState = () => {
    const cursor = address.searchParams.get("historyCursor") || undefined;
    const query = address.searchParams.get("historyQuery") || undefined;
    const previous = address.searchParams.getAll("historyPrevious");
    return cursor || query || previous.length ? { history: { ...(cursor ? { cursor } : {}), ...(query ? { query } : {}), ...(previous.length ? { previous } : {}) } } : {};
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
    return { ...base, view, ...(view === "history" ? historyState() : {}), sheet: { taskId: id, tab: detail as SheetTab || "overview", list: view === "board" ? "board" : view === "history" ? "history" : undefined, ...(stepId ? { stepId } : {}) } };
  }
  if (page && Object.hasOwn(PAGE_NAMES, page)) {
    const route = { ...base, view: page as Page, ...(page === "history" ? historyState() : {}) };
    if (parts.length === 1) return route;
    if (page === "library" && ["routines", "roles", "profiles"].includes(id ?? "") && parts.length === 2) return { ...route, libraryView: id as AppRoute["libraryView"] };
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
  if (route.view === "history" && route.history) {
    if (route.history.cursor) query.set("historyCursor", route.history.cursor);
    if (route.history.query) query.set("historyQuery", route.history.query);
  }
  if (route.sheet) {
    path = `/tasks/${encodeURIComponent(route.sheet.taskId)}${route.sheet.tab === "overview" ? "" : `/${route.sheet.tab}`}`;
    if (route.view !== "board") query.set("from", route.view);
    if (route.sheet.stepId) query.set("node", route.sheet.stepId);
  } else if (route.view === "library" && route.libraryView) path += `/${route.libraryView}`;
  else if (route.view === "products" && route.productSettings) path += `/${encodeURIComponent(route.productSettings)}/settings`;
  const suffix = query.toString();
  return path + (suffix ? `?${suffix}` : "");
}

export function useAppRoute() {
  const readCurrent = () => {
    const route = readRoute(new URL(window.location.href));
    const previous: unknown = window.history.state?.petrinaHistoryPrevious;
    if (route.view === "history" && Array.isArray(previous) && previous.length && previous.every((cursor) => typeof cursor === "string")) return { ...route, history: { ...route.history, previous: previous.slice(-50) as string[] } };
    return route;
  };
  const [route, setRoute] = useState(readCurrent);
  const current = useRef(route);
  const navigate = useCallback((change: (previous: AppRoute) => AppRoute, replace = false) => {
    const next = { ...change(current.current) };
    delete next.missing;
    const href = routeHref(next);
    if (href !== window.location.pathname + window.location.search) {
      window.history[replace ? "replaceState" : "pushState"](next.view === "history" ? { petrinaHistoryPrevious: next.history?.previous?.slice(-50) ?? [] } : {}, "", href);
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
