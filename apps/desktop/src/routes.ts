import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { readRoute, routeHref as encodeRoute, type AppRoute } from "./route-codec";
export { PAGE_NAMES, readRoute } from "./route-codec";
export type { AppRoute, TaskRoute } from "./route-codec";

/** Keep the browser's open-in-new-tab and copy-link behaviour. */
export function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

/** Preserve the browser API: omitted search uses this window's current address. */
export function routeHref(route: AppRoute, search = window.location.search): string {
  return encodeRoute(route, search);
}

export function useAppRoute() {
  const readCurrent = () => {
    const route = readRoute(new URL(window.location.href));
    const previous: unknown = window.history.state?.petrinaHistoryPrevious;
    if (route.view === "history" && Array.isArray(previous) && previous.length && previous.every((cursor) => typeof cursor === "string")) return {
      ...route,
      history: {
      ...route.history,
      previous: previous.slice(-50) as string[]
    }
    };
    if (route.view === "routines" && route.routineRuns && Array.isArray(previous) && previous.every((cursor) => typeof cursor === "string")) return {
      ...route,
      routineRuns: {
      ...route.routineRuns,
      history: {
      ...route.routineRuns.history,
      previous: previous.slice(-50) as string[]
    }
    }
    };
    return route;
  };
  const [route, setRoute] = useState(readCurrent);
  const current = useRef(route);
  const navigate = useCallback((change: (previous: AppRoute) => AppRoute, replace = false) => {
    const next = { ...change(current.current) };
    delete next.missing;
    const href = routeHref(next);
    if (href !== window.location.pathname + window.location.search) {
      window.history[replace ? "replaceState" : "pushState"](
        { petrinaHistoryPrevious: (next.view === "history" ? next.history : next.view === "routines" ? next.routineRuns?.history : undefined)?.previous?.slice(-50) ?? [] },
        "",
        href
      );
    }
    current.current = next;
    setRoute(next);
  }, []);
  useEffect(() => {
    const follow = () => {
      const next = readCurrent();
      current.current = next;
      setRoute(next);
    };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  return [route, navigate] as const;
}
