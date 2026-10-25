import type { Id, DeepMutable, Task } from "@petrina/core";
import { MAX_TOOL_INVOCATIONS } from "@petrina/agent-runtime/tool-invocations";
import type { ToolActivityEvent } from "@petrina/orchestrator";

/** Shared bookkeeping for main agents, reviewer seats and voter seats. */
export function recordToolActivity(task: Pick<DeepMutable<Task>, "journey">, journeyId: Id, worker: { seat: string; roleId: Id; profileId: Id; productId: Id }, event: ToolActivityEvent) {
  const step = task.journey?.find(step => step.id === journeyId);
  if (!step) return undefined;
  const summary = step.toolActivity?.[worker.seat] ?? { actionCount: 0 };
  Object.assign(summary, { roleId: worker.roleId, profileId: worker.profileId, productId: worker.productId });
  if (event.isNew) summary.actionCount++;
  if (event.lastActivity !== undefined) summary.lastActivity = event.lastActivity;
  if (event.runningTool) summary.runningTool = { ...event.runningTool };
  else delete summary.runningTool;
  step.toolActivity = { ...step.toolActivity, [worker.seat]: summary };
  const invocation = event.invocation;
  if (invocation) {
    const records = step.toolInvocations ?? [];
    const index = records.findIndex(record => record.id === invocation.id);
    const record = { ...invocation, paths: invocation.paths ? [...invocation.paths] : undefined, ...worker };
    if (index >= 0) records[index] = record;
    else if (event.isNew) records.push(record);
    step.toolInvocations = records.slice(-MAX_TOOL_INVOCATIONS);
  }
  if (event.turnEndedAt !== undefined) {
    for (const record of step.toolInvocations ?? []) {
      if (record.turnId === event.turnId && record.seat === worker.seat && record.status !== "completed" && record.status !== "failed") record.turnEndedAt = event.turnEndedAt;
    }
  }
  return summary;
}
