export interface DrainEffects {
  requestStop(): void;
  stopped(): boolean;
  inFlight(): number;
  /** Present even when the original failure is undefined. It never confirms cleanup. */
  failure?(): { error: unknown } | undefined;
}
export interface DrainClock { now(): number; sleep(ms: number): Promise<void> }

/** Stop admitting work, then observe existing owners at the established 500ms cadence. */
export async function drainRuntime(effects: DrainEffects, clock: DrainClock, limitMs: number, onWait?: (left: number) => void): Promise<number> {
  effects.requestStop();
  const started = clock.now();
  let last = -1;
  while (!effects.stopped()) {
    const left = effects.inFlight();
    if (left !== last) {
      onWait?.(left);
      last = left;
    }
    if (left === 0) {
      const failure = effects.failure?.();
      if (failure) throw failure.error;
      return 0;
    }
    if (clock.now() - started >= limitMs) return left;
    await clock.sleep(500);
  }
  const failure = effects.failure?.();
  if (failure) throw failure.error;
  return 0;
}

/** Active agents take priority; a finalizer is counted only when no agent remains. */
export function inFlightWork(owners: { agents: number; settling: number; copyCleanups: number; background: number; terminals: number }): number {
  return owners.agents || owners.settling + owners.copyCleanups + owners.background + owners.terminals;
}

/** Counts are already filtered by the host's paused-check ownership observations. */
export function keepsIdleSleep(owners: {
  stopped: boolean;
  drivers: boolean;
  settling: boolean;
  agents: boolean;
  helpers: boolean;
  screenGroups: boolean;
  switching: boolean;
  copyCleanups: boolean;
  cleanupJobs: boolean;
  extraChecks: boolean
}): boolean {
  return !owners.stopped && (owners.drivers || owners.settling || owners.agents || owners.helpers || owners.screenGroups || owners.switching || owners.copyCleanups || owners.cleanupJobs || owners.extraChecks);
}
