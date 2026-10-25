import { pauseClock, resumeClock, type Column } from "@petrina/core";
import type { RuntimeTask } from "./model.js";

/** Exact step-time transformation shared by the live host and portable workflow owner. */
export function pauseAgentStep(task: RuntimeTask, now: number): void {
  if (task.stepClock) task.stepClock = pauseClock(task.stepClock, Math.max(now, task.stepClock.since ?? 0));
  for (const work of Object.values(task.hunt?.work ?? {})) {
    if (work.clock) work.clock = pauseClock(work.clock, Math.max(now, work.clock.since ?? 0));
  }
}

/** Release the actual main place; recording remains with the caller at its original position. */
export function waitForAgentUsage(task: RuntimeTask, words: string, now: number, column: () => Column): void {
  pauseAgentStep(task, now);
  task.state = "waiting";
  task.holdsSlot = false;
  delete task.agent;
  task.statusLine = words;
  task.column = column();
}

/** Opening the actual coordinator decision releases only the main place at this exact boundary. */
export function releaseAgentForDecision(task: RuntimeTask): void {
  delete task.agent;
  task.holdsSlot = false;
}

/** Answering a live question preserves its existing place; an interrupted one waits for admission. */
export function resumeAgentAfterReply(task: RuntimeTask, blocking: boolean, now: number): void {
  if (task.state !== "needs-you") return;
  if (blocking) return;
  task.state = task.holdsSlot ? "running" : "waiting";
  task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
  if (task.holdsSlot && task.stepClock && !task.agent?.reviewKey) task.stepClock = resumeClock(task.stepClock, now);
}
