import type { Id } from "@petrina/core";
import type { Kernel } from "./kernel.js";
import type { RepositoryContext } from "@petrina/orchestrator";

/** A side errand may survive a restart without replacing the main step's saved conversation. */
export function beginSideStep(k: Kernel, { task, work }: RepositoryContext, roleId: Id): () => void {
  if (work.sideStep && work.sideStep.roleId !== roleId) throw new Error("Another internal step is still unfinished.");
  if (!work.sideStep) {
    work.sideStep = structuredClone({ roleId, ...(work.conversation?.roleId !== roleId && work.conversation ? { conversation: work.conversation } : {}), ...(work.stepAttempts !== undefined ? { stepAttempts: work.stepAttempts } : {}), ...(task.todo !== undefined ? { todo: task.todo } : {}), ...(task.stepClock ? { stepClock: task.stepClock } : {}) });
    if (work.conversation?.roleId !== roleId) delete work.conversation;
    k.commitNow();
  }
  return () => {
    const saved = work.sideStep;
    if (!saved) return;
    if (saved.conversation) work.conversation = saved.conversation;
    else delete work.conversation;
    if (saved.stepAttempts !== undefined) work.stepAttempts = saved.stepAttempts;
    else delete work.stepAttempts;
    if (saved.todo !== undefined) task.todo = saved.todo;
    else delete task.todo;
    if (saved.stepClock) task.stepClock = saved.stepClock;
    else delete task.stepClock;
    delete work.sideStep;
  };
}
