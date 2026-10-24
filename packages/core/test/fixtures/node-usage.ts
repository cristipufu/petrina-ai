import { createTaskState } from "../../src/task-transitions.js";
import { nodeUsage } from "../../src/node-usage.js";
import { MemoryWorkLog, type WorkTurn } from "../../src/worklog.js";
import type { JourneyStep, Task } from "../../src/model.js";

export const NOW = 1_800_000_000_000;
export const agent = (id: string, start: number, end?: number, extra: Partial<JourneyStep> = {}): JourneyStep => ({ id, kind: "agent", stageId: "review", roleId: "code-reviewer", round: 3, sub: 0, startedAt: start, ...(end === undefined ? {} : { endedAt: end }), ...extra });
export function fixture(journey: JourneyStep[]) {
  const product = { id: "product", name: "Usage fixture", repo: "acme/usage", tone: "blue" as const };
  const task: Task = { ...createTaskState({ productId: product.id, title: "Measure this node", backlog: true }, [product],
    { id: "task", timelineId: "created", now: NOW, priority: 0 }), journey };
  const state = { tasks: [task] };
  const log = new MemoryWorkLog(1);
  const turn = (id: string, extra: Partial<WorkTurn> = {}) => {
    const row: WorkTurn = { id, taskId: task.id, productId: task.productId, stageId: "review", stageTitle: "Review", stageKind: "review-chain", round: 3, fixing: false, roleId: "code-reviewer", toolId: "codex", profileId: "sol-high", sessionId: "same-session", modelRan: "sol", reason: "first", startedAt: 11, endedAt: 19, end: "finished", mainOnly: false, helpers: 0, tokens: { total: 100 }, ...extra };
    log.addTurn(row); return row;
  };
  const view = (nodeId = journey[0]!.id, archived = false) => nodeUsage(log, { taskId: task.id, nodeId }, { state: archived ? { ...state, tasks: [] } : state, now: NOW, task: () => task });
  return { state, task, log, turn, view };
}

