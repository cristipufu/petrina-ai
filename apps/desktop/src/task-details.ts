import { useEffect, useRef, useState } from "react";
import type { Task } from "@petrina/core";
import { failureText, sim } from "./engine";

/** One open task, refreshed by revisions. Idle sheets own no polling timer. */
export function useTaskDetails(id: string | undefined, needed: boolean, liveRevision: string | undefined, historyRevision: number | undefined, archived: boolean, retry: number) {
  const [result, setResult] = useState<{ id: string; task?: Task; error?: string }>();
  const revision = archived ? `history:${historyRevision ?? 0}` : liveRevision;
  const latest = useRef({ revision, archived });
  latest.current = { revision, archived };
  const refresh = useRef<() => void>(undefined);

  useEffect(() => {
    setResult(undefined);
    if (!id || !needed) return;
    let cancelled = false;
    let running = false;
    let first = true;
    let loaded: string | undefined;
    let requested: string | undefined;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      running = true;
      first = false;
      started = Date.now();
      const request = latest.current;
      requested = request.revision;
      try {
        const task = await sim.taskDetails(id);
        if (cancelled) return;
        // Archive notifications use the history revision; live responses carry the exact
        // revision they read, including changes that arrived while this request was open.
        loaded = request.archived ? request.revision : task?.detailsRevision ?? request.revision;
        setResult({ id, task });
      } catch (error) {
        if (cancelled) return;
        loaded = request.revision;
        setResult(previous => ({ ...previous, id, error: failureText(error) }));
      } finally {
        running = false;
        if (!cancelled) schedule();
      }
    };
    const schedule = () => {
      if (cancelled || running || timer !== undefined || (!first && (loaded === latest.current.revision || requested === latest.current.revision))) return;
      const delay = Math.max(0, 400 - (Date.now() - started));
      if (!delay) {
        void load();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, delay);
    };
    refresh.current = schedule;
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      refresh.current = undefined;
    };
  }, [id, needed, retry]);

  useEffect(() => { refresh.current?.(); }, [revision]);
  return result;
}
