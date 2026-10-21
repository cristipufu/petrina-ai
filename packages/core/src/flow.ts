// The rules every run of a task follows, shared by the real engine and the demo simulator so the two
// never drift: which board column a task is in, what a checkpoint says, where a request for changes
// sends the task, and how design and review rounds end.

import { roleForTask } from "./roles.js";
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
  if (task.state === "backlog") return "backlog";
  if (task.stageIndex < 0) return "planning";
  const stage = task.plan?.stages[task.stageIndex];
  if (!stage) return "ready";
  if (stage.kind === "gate") return stage.gate === "plan" ? "planning" : stage.gate === "design" ? "designing" : "ready";
  if (stage.kind === "review-chain") return "reviewing";
  return roleForTask(roles, stage.roleId, task)?.column ?? "building";
}

export const GATE_TITLE: Record<GateKind, (title: string) => string> = {
  plan: (title) => `Approve the plan for “${title}”`,
  design: (title) => `Check the design for “${title}”`,
  delivery: (title) => `Ready to ship “${title}”`,
};

/** Important findings still open when the work reaches the coordinator. */
function stillBlocking(task: Task): number {
  return task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking").length;
}

/** A check problem names the checks that still fail, not a count of the findings they raise. */
export function checkProblemTitle(title: string, failing: readonly string[]): string {
  return `Your call on “${title}”: ${failing.length === 1 ? "a check still fails" : "checks still fail"} (${failing.join(", ")})`;
}

/** What a checkpoint is called in the inbox. Failing checks, then Important findings still open, say so first. */
export function gateTitle(task: Task, gate: GateKind): string {
  const failing = gate === "delivery" ? task.checks?.results.filter((run) => !run.ok).map((run) => run.name) ?? [] : [];
  if (failing.length) return checkProblemTitle(task.title, failing);
  const open = gate === "delivery" ? stillBlocking(task) : 0;
  if (open) return `Your call on “${task.title}”: ${open === 1 ? "1 blocking finding" : `${open} blocking findings`} still open`;
  const unverified = gate === "delivery" ? task.brief?.acceptance.filter((item) => item.verification === "blocked").length ?? 0 : 0;
  return unverified ? `Your call on “${task.title}”: ${unverified === 1 ? "1 acceptance check could not be verified" : `${unverified} acceptance checks could not be verified`}` : GATE_TITLE[gate](task.title);
}

/** The status line while a check problem waits for the coordinator. */
export const CHECKS_STILL_FAIL = "Checks still fail. Your call";

/** The task's status line while a checkpoint waits on the coordinator. */
export function gateStatus(task: Task, gate: GateKind): string {
  if (gate === "plan") return "Plan ready. Waiting for your OK";
  if (gate === "design") return callOn(task, task.stageIndex) ? CALL_WORDS.waiting : "Design settled. Waiting for your check";
  const open = stillBlocking(task);
  if (task.checks?.results.some((run) => !run.ok)) return CHECKS_STILL_FAIL;
  // Never "done" while Important findings are open: the rounds ran out and the coordinator decides.
  if (open) return `Review rounds ran out with ${open === 1 ? "1 blocking finding" : `${open} blocking findings`} open. Your call`;
  const unverified = task.brief?.acceptance.filter((item) => item.verification === "blocked").length ?? 0;
  if (unverified) return `${unverified === 1 ? "1 acceptance check could not be verified" : `${unverified} acceptance checks could not be verified`}. Your call`;
  return "Reviews done. Waiting for your OK to ship";
}

/**
 * Where a task goes when the coordinator asks for changes at a checkpoint. On a disagreement the note
 * is their call, which settles the design; on a design check, the design goes back to the architects
 * and returns to this same check; on a delivery check, the work goes back to the builder; on a plan,
 * the planner starts over. Says whether the note was a call.
 */
export function afterChangesAsked(task: DeepMutable<Task>, kind: InboxKind, note: string, now: number, roles: readonly Role[]): { call: boolean } {
  const stages = task.plan?.stages ?? [];
  if (task.repositories && (kind === "design" || kind === "disagreement")) task.designRevision = (task.designRevision ?? 0) + 1;
  const call = kind === "disagreement" ? startCall(task as unknown as Task, note, now, roles) : undefined;
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
    const index = lastIndexWhere(stages, (stage) => roleForTask(roles, stage.roleId, task)?.result === "build" && stage.kind === "do");
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

/** The most review rounds a stage runs on its own, however well it converges: past it the coordinator decides. */
export const MAX_REVIEW_ROUNDS = 5;

/** Shared convergence decision. No open findings previews whether one newly found blocker could return. */
export function allowsReviewFix(task: Task, stage: Stage, round: number): boolean {
  if (round < (stage.maxRounds ?? 2)) return true;
  const current = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
  const currentIds = new Set(current.map((finding) => finding.id));
  const previous = task.blockingFindingsAfter?.[stage.id]?.at(-1);
  const before = task.blockingAfter?.[stage.id]?.at(-1);
  const progress = previous ? previous.some((id) => !currentIds.has(id)) : before !== undefined && Math.max(1, current.length) < before;
  return round < MAX_REVIEW_ROUNDS && progress;
}

/**
 * Past its planned rounds, a review keeps sending the work back while it converges (each round resolves at least
 * one previously open Important finding), up to MAX_REVIEW_ROUNDS. Only a round that stops making progress hands
 * the decision to the coordinator. Older saved tasks without finding snapshots use the count as a fallback.
 */
export function reviewRoundEnd(task: Task, stage: Stage, round: number, roles: readonly Role[]): ReviewRoundEnd {
  const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking").length;
  if (open === 0) return { kind: "passed" };
  const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && roleForTask(roles, entry.roleId, task)?.result === "build");
  if (builder < 0) return { kind: "used up", open };
  if (allowsReviewFix(task, stage, round)) return { kind: "send back", builder, open };
  return { kind: "used up", open };
}

/** How many Important findings a review round ended with, for the next round's convergence check. */
export function noteRoundEnd(task: DeepMutable<Task>, stageId: string, open: number): void {
  task.blockingAfter = { ...(task.blockingAfter ?? {}), [stageId]: [...(task.blockingAfter?.[stageId] ?? []), open] };
  const ids = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking").map((finding) => finding.id);
  task.blockingFindingsAfter = { ...(task.blockingFindingsAfter ?? {}), [stageId]: [...(task.blockingFindingsAfter?.[stageId] ?? []), ids] };
}
