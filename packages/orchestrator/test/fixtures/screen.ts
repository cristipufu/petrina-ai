import { createTaskState, type Column, type Product } from "@petrina/core";
import { ScreenArbitration, type RuntimeTask, type ScreenGroup, type ScreenHost, type ScreenRuntimeState } from "../../src/index.js";
import { ControlledClock } from "./clock.js";

const products: readonly Product[] = [{ id: "p", name: "Screen fixture", repo: "local/p", tone: "blue" }];

export function screenFixture(count = 2) {
  const clock = new ControlledClock();
  const tasks = Array.from({ length: count }, (_, index) => {
    const task = createTaskState({ productId: "p", title: `Screen task ${index + 1}`, backlog: true }, products,
      { id: `task-${index + 1}`, timelineId: `created-${index}`, priority: index, now: clock.now() });
    task.repository = { productId: "p", delivery: "local", worktree: `workspace-${task.id}` };
    task.plan = { rationale: "Screen arbitration", plannerProfileId: "planner", stages: [{ id: "build", kind: "do", roleId: "builder", profileIds: ["profile"], title: "Build" }] };
    task.stageIndex = 0; task.state = "running"; task.column = "building"; task.holdsSlot = true;
    task.agent = { roleId: "builder", profileId: "profile", since: clock.now(), step: 0 };
    return task;
  });
  const state: ScreenRuntimeState = { tasks, pool: { screen: { mode: "off" } }, inbox: [] };
  const records: { taskId: string; tone: string; text: string; roleId?: string; profileId?: string }[] = [];
  const checkpoints: ScreenRuntimeState[] = [], columns: string[] = [], owned = new Set<string>();
  let scheduled = 0, stopped = false, ids = 0, reads = 0;
  const column = { value: "building" as Column };
  let controller!: ScreenArbitration;
  const host: ScreenHost = {
    state() { reads++; return state; }, task: id => state.tasks.find(task => task.id === id), stopped: () => stopped,
    sessionOwned: task => owned.has(task.id), waitLine: () => "Waiting for the prerequisite to land",
    column(task) { columns.push(task.id); return column.value; },
    record(target, tone, text, roleId, profileId) { records.push({ taskId: "task" in target ? target.task.id : target.id, tone, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) }); },
    inboxId: () => `screen-${++ids}`, checkpoint: () => { checkpoints.push(structuredClone(state)); },
    schedule() { scheduled++; controller.syncScreen(); },
  };
  controller = new ScreenArbitration(host, clock);
  return { controller, host, state, clock, records, checkpoints, columns, column, owned,
    task: (index = 0) => tasks[index]!, scheduled: () => scheduled, reads: () => reads,
    stopHost: () => { stopped = true; }, screenItems: () => state.inbox.filter(item => item.kind === "screen") };
}

export function savedScreenTurn(task: RuntimeTask, key: string, at: number, allowed = false) {
  task.hunt ??= { stageId: "review", round: 1, reported: {} };
  task.hunt.screenTurns ??= {};
  const turn = { reason: `Inspect ${key}`, at, copy: `copy-${key}`, ...(allowed ? { allowed: true } : {}),
    conversation: { step: "review:1", roleId: "code-reviewer", profileId: key, toolId: "codex", model: "model", sessionId: `session-${key}`, startedAt: at, briefed: true } };
  task.hunt.screenTurns[key] = turn;
  return turn;
}

/** Only membership/yield observations are in this controller's contract. Other group actions fail if called. */
export function screenGroup(running: ReadonlySet<string> = new Set(), yielded?: string[]): ScreenGroup {
  const unexpected = (): never => { throw new Error("Unexpected review-group action"); };
  return { continue: unexpected, recipients: unexpected, finished: unexpected, running: member => running.has(member),
    ...(yielded ? { yield: (member: string) => { yielded.push(member); } } : {}) };
}
