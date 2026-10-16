import { useSyncExternalStore } from "react";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS, Simulator, type State } from "@petrina/core";

// Until the ACP engine lands, the app runs on the simulated squad with synthetic data.
// `?demo=portfolio` opens twenty products instead of three.
const TICK_MS = 2_200;

function demo() {
  const now = Date.now();
  if (new URLSearchParams(window.location.search).get("demo") === "portfolio") return createPortfolioDemo(now);
  return { state: createDemoState(now), triggers: DEMO_TRIGGERS };
}

const initial = demo();

export const sim = new Simulator(initial.state, {
  triggers: initial.triggers,
  prMergeAfter: 45,
  tickMs: TICK_MS,
});

let timer: ReturnType<typeof setInterval> | undefined;

export function startClock(): () => void {
  if (!timer) timer = setInterval(() => sim.tick(Date.now()), TICK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}

export function useSim(): State {
  return useSyncExternalStore(sim.subscribe, sim.getState);
}
