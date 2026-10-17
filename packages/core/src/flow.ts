// The rules every run of a task follows, shared by the real engine and the demo simulator so the two
// never drift: which board column a task is in, what a checkpoint says, where a request for changes
// sends the task, and how design and review rounds end.

import { CALL_WORDS, callOn, designStageIndex, startCall } from "./call.js";
import type { Column, GateKind, InboxKind, Role, Stage, Task } from "./model.js";

/** A writable copy of a read-only state type: what the engine and the simulator change in place. */
export type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[] : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

export function lastIndexWhere<T>(items: readonly T[], match: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index]!, index)) return index;
  return -1;
}

/** The board column a task belongs in, from its state and the stage it is on. */
export function columnOf(task: Task, roles: readonly Role[]): Column {
  if (task.state === "cancelled" || task.state === "done") return "done";
  if (task.state === "pr-open") return "ready";
  if (task.state === "queued") return "queue";
  if (task.stageIndex < 0) return "planning";
  const stage = task.plan?.stages[task.stageIndex];
  if (!stage) return "ready";
  if (stage.kind === "gate") return stage.gate === "plan" ? "planning" : stage.gate === "design" ? "designing" : "ready";
  if (stage.kind === "review-chain") return "reviewing";
  return roles.find((role) => role.id === stage.roleId)?.column ?? "building";
}

export const GATE_TITLE: Record<GateKind, (title: string) => string> = {
  plan: (title) => `Approve the plan for “${title}”`,
  design: (title) => `Check the design for “${title}”`,
  delivery: (title) => `Ready to ship “${title}”`,
};

/** Important findings still open: the review rounds ran out before they were settled. */
function stillBlocking(task: Task): number {
  return task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking").length;
}

/** What a checkpoint is called in the inbox. A delivery with Important findings still open says so first. */
export function gateTitle(task: Task, gate: GateKind): string {
  const open = gate === "delivery" ? stillBlocking(task) : 0;
  return open ? `Your call on “${task.title}”: ${open === 1 ? "1 blocking finding" : `${open} blocking findings`} still open` : GATE_TITLE[gate](task.title);
}

/** The task's status line while a checkpoint waits on the coordinator. */
export function gateStatus(task: Task, gate: GateKind): string {
  if (gate === "plan") return "Plan ready. Waiting for your OK";
  if (gate === "design") return callOn(task, task.stageIndex) ? CALL_WORDS.waiting : "Design settled. Waiting for your check";
  const open = stillBlocking(task);
  // Never "done" while Important findings are open: the rounds ran out and the coordinator decides.
  if (open) return `Review rounds ran out with ${open === 1 ? "1 blocking finding" : `${open} blocking findings`} open. Your call`;
  return "Reviews done. Waiting for your OK to ship";
}

/**
 * Where a task goes when the coordinator asks for changes at a checkpoint. On a disagreement the note
 * is their call, which settles the design; on a design check, the design goes back to the architects
 * and returns to this same check; on a delivery check, the work goes back to the builder; on a plan,
 * the planner starts over. Says whether the note was a call.
 */
export function afterChangesAsked(task: DeepMutable<Task>, kind: InboxKind, note: string, now: number): { call: boolean } {
  const stages = task.plan?.stages ?? [];
  const call = kind === "disagreement" ? startCall(task as unknown as Task, note, now) : undefined;
  if (call && task.plan) {
    // The call is final: the architect follows it once, then the coordinator checks the brief. No review round.
    task.plan.stages = call.stages as DeepMutable<Stage>[];
    task.stageIndex = call.stageIndex;
    task.call = call.call as DeepMutable<Task>["call"];
  } else if (kind === "plan") {
    task.stageIndex = -1;
    delete task.plan;
  } else if (kind === "design" || kind === "disagreement") {
    // Back to this very check afterwards, not to an earlier one the coordinator already approved.
    if (kind === "design") task.returnToCheck = task.stageIndex;
    const index = designStageIndex(stages as Stage[], task.stageIndex);
    if (index >= 0) {
      // On a design the call settled, changes go to the architect alone and come back to the same check.
      if (!callOn(task as unknown as Task, index)) task.rounds[stages[index]!.id] = (task.rounds[stages[index]!.id] ?? 1) + 1;
      task.stageIndex = index;
    }
  } else if (kind === "delivery") {
    task.sentBack = (task.sentBack ?? 0) + 1;
    const index = lastIndexWhere(stages, (stage) => stage.roleId === "builder" && stage.kind === "do");
    if (index >= 0) {
      task.stageIndex = index;
      task.fixing = true;
    }
  }
  task.sub = 0;
  return { call: call !== undefined };
}

/** How a design round ends, from the reviewer's blocking objections. */
export function designRoundEnd(blocking: number, round: number, stage: Stage): "settled" | "disagreement" | "next round" {
  if (blocking === 0) return "settled";
  return round >= (stage.maxRounds ?? 3) ? "disagreement" : "next round";
}

/**
 * How a review round ends: back to the builder with what is Important, passed, or with rounds used up
 * and Important findings still open (then the coordinator always looks before anything ships).
 */
export type ReviewRoundEnd = { kind: "send back"; builder: number; open: number } | { kind: "passed" } | { kind: "used up"; open: number };

export function reviewRoundEnd(task: Task, stage: Stage, round: number): ReviewRoundEnd {
  const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking").length;
  if (open === 0) return { kind: "passed" };
  const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
  if (builder >= 0 && round < (stage.maxRounds ?? 2)) return { kind: "send back", builder, open };
  return { kind: "used up", open };
}
