import { useEffect, useState } from "react";
import { nextReset, type State, type UsageReport, type UsageRequest, type UsageViewFor } from "@petrina/core";
import { sim } from "./engine";

/**
 * The time to word limits against. It moves on by itself, so "reported 3m ago" stays true, and
 * it ticks the moment a limit resets, so its old percentage never shows as current.
 */
export function useLimitClock(limits: readonly UsageReport[], initial = Date.now()): number {
  const [now, setNow] = useState(initial);
  const reset = nextReset(limits, now);
  useEffect(() => {
    const wait = reset === undefined ? 30_000 : Math.min(30_000, reset - Date.now() + 250);
    const timer = setTimeout(() => setNow(Date.now()), Math.max(250, wait));
    return () => clearTimeout(timer);
  }, [now, reset]);
  return now;
}

function midnight(): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * The numbers for one view. Asked for again whenever the work log gets an entry (the
 * state's counter changes) and when the local day rolls over, so nothing needs reopening.
 */
export function useUsage<R extends UsageRequest>(request: R | undefined, state: State): UsageViewFor<R> | undefined {
  const key = request ? JSON.stringify(request) : "";
  const version = state.work?.version ?? 0;
  // Analytics stays useful while the squad is paused and no work-log entry changes its version.
  const refreshMinute = request?.view === "analytics" ? Math.floor(state.now / 60_000) : 0;
  const [day, setDay] = useState(midnight);
  const [view, setView] = useState<{ key: string; value: UsageViewFor<R> }>();

  useEffect(() => {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const timer = setTimeout(() => setDay(midnight()), Math.max(1000, next.getTime() - Date.now() + 500));
    return () => clearTimeout(timer);
  }, [day]);

  useEffect(() => {
    if (!request) return;
    let live = true;
    void (async () => {
      try {
        // The command table answers any view; this one is the view asked for.
        const value = (await sim.usage(request)) as UsageViewFor<R>;
        if (live) setView({ key, value });
      } catch {
        // Not reachable right now: the view keeps what it last showed.
      }
    })();
    return () => {
      live = false;
    };
    // The request is identified by its key.
  }, [key, version, day, refreshMinute]);

  return request && view?.key === key ? view.value : undefined;
}
