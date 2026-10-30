import { CODEX_USAGE_EVERY_MS } from "@petrina/agent-runtime/codex-usage";
import { legacyJourney, recoverMessages, type CheckId } from "@petrina/core";
import type { AcceptedPoints } from "./accepted-points.js";
import type { Cleanup } from "./cleanup.js";
import type { Driver } from "./driver.js";
import type { FollowUps } from "./follow-ups.js";
import type { EngineOptions, Kernel, RuntimeTask } from "./kernel.js";
import type { ProductChecks } from "./product-checks.js";
import type { Shipping } from "./shipping.js";
import type { ToolChecks } from "./tool-checks.js";

export interface EngineStartupContext {
  readonly kernel: Kernel;
  readonly options: EngineOptions;
  readonly shipping: Shipping;
  readonly driver: Driver;
  readonly checks: ProductChecks;
  readonly tools: ToolChecks;
  readonly followUps: FollowUps;
  readonly cleanup: Cleanup;
  readonly acceptedPoints: AcceptedPoints;
  readonly pollRoutines: () => void;
  readonly pollPullRequests: () => void;
  readonly checkpointStepTimes: () => void;
}

export function prepareRecoveredTasks(kernel: Kernel, shipping: Shipping): void {
  // Tasks from before journeys were recorded: one step per finished stage, and the step under way, so new steps follow on from there.
  for (const task of kernel.s.tasks) {
    if (!task.journey && task.startedAt !== undefined) {
      task.journey = legacyJourney(task, kernel.s.inbox, kernel.s.roles) as RuntimeTask["journey"];
    }
  }
  // Deliveries a Petrina from before this version left halfway: never acted on by themselves.
  shipping.carryOverShipping();
  for (const task of kernel.s.tasks) recoverMessages(task);
}

export function startEngineBackgroundLoops(context: EngineStartupContext): Promise<void> {
  const {
    kernel,
    options,
    shipping,
    driver,
    checks,
    tools,
    followUps,
    cleanup,
    acceptedPoints,
    pollRoutines,
    pollPullRequests,
    checkpointStepTimes,
  } = context;
  driver.recover();
  void kernel.trackWork(checks.restoreEvidence().catch(() => undefined));
  // Recovered Builders get a short login check on their saved tool before fallback selection.
  // Other roles keep their existing recovery rules; the usual check timeout bounds this wait.
  for (const task of kernel.s.tasks.filter((entry) => entry.state === "waiting")) {
    const planned = task.plan?.stages[task.stageIndex]?.profileIds[0];
    const own = planned ? kernel.builderConversation(task, planned) : undefined;
    if (own) {
      void tools.check(own.toolId as CheckId).then(() => {
        if (!kernel.stopped) kernel.schedule();
      });
    }
  }
  kernel.timers.push(
    setInterval(() => {
      try {
        pollRoutines();
        kernel.schedule();
      } catch (error) {
        console.error("Could not save maintenance admission:", error);
      }
    }, 15_000),
  );
  kernel.armScreenTimer();
  kernel.timers.push(
    setInterval(() => {
      pollPullRequests();
      shipping.monitor.settleCancelledTasks();
      // Apart from GitHub: a slow lookup never holds up removing copies.
      // Confirmed older bugs are linked before a finished task's pictures are removed.
      void kernel.trackWork(
        followUps
          .catchUp()
          .catch(() => undefined)
          .then(() => cleanup.sweep()),
      );
      void kernel.trackWork(acceptedPoints.sweep());
    }, options.checkEveryMs ?? 60_000),
    // Codex's usage, every ten minutes while any agent runs (Claude Code reports its own on every turn).
    setInterval(() => {
      if (kernel.runs.size || [...kernel.helperRuns.values()].some((runs) => runs.size)) kernel.readUsage();
    }, CODEX_USAGE_EVERY_MS),
    // A long command may send no activity. Save its working time too, so a forced stop loses little of it.
    setInterval(() => checkpointStepTimes(), 15_000),
  );
  shipping.monitor.settleCancelledTasks();
  pollPullRequests();
  kernel.schedule();
  kernel.readUsage();
  // Catch up at start: link any older bug saved only part-way, then remove finished working copies.
  const startupSweep = kernel
    .trackWork(
      followUps
        .catchUp()
        .catch(() => undefined)
        .then(() => cleanup.sweep()),
    )
    .catch(() => undefined);
  void kernel.trackWork(acceptedPoints.sweep());
  return startupSweep;
}
