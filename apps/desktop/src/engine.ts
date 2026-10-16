import { useSyncExternalStore } from "react";
import { createDemoState, DEMO_TRIGGERS, Simulator, type State } from "@petrina/core";

// Until the ACP engine lands (M2), the app runs on the simulated squad with synthetic data.
const TICK_MS = 2_200;

export const sim = new Simulator(createDemoState(Date.now()), {
  triggers: DEMO_TRIGGERS,
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
