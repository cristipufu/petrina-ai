// The rules every run of a task follows, shared by the real engine and the demo simulator so the two
// never drift: which board column a task is in, what a checkpoint says, where a request for changes
// sends the task, and how design and review rounds end.

import { roleForTask } from "./roles.js";
import { checkProblem, deliveryCheckProblem, deliveryCheckWorks } from "./check-evidence.js";
import { checkOutcome } from "./check-outcome.js";
import { proofGap } from "./proof-requests.js";
import { exhaustedAcceptanceFailure, restoredAcceptance } from "./acceptance.js";
import { CALL_WORDS, callOn, designStageIndex, startCall } from "./call.js";
import { assignedProducts, taskProductIds } from "./repositories.js";
import { findingCount } from "./findings.js";
import { JOURNEY_WORDS } from "./journey.js";
import type { Column, Finding, GateKind, Id, InboxKind, Role, Stage, Task } from "./model.js";

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
export function checkProblemTitle(title: string, failing: readonly string[], unverified: readonly string[] = []): string {
  return `Your call on “${title}”: ${failing.length === 1 ? "a check still fails" : "checks still fail"} (${failing.join(", ")})${unverified.length ? `; unverified (${unverified.join(", ")})` : ""}`;
}

/** What a checkpoint is called in the inbox. Failing checks, then Important findings still open, say so first. */
export const reviewDecisionPending = (task: Pick<Task, "reviewDecision">): boolean => task.reviewDecision?.accepted === false;

export function gateTitle(task: Task, gate: GateKind): string {
  if (gate === "delivery" && reviewDecisionPending(task)) return `Your call on “${task.title}”: review needs a decision before final checks`;
  if (gate === "delivery" && deliveryCheckProblem(task) === "unverified") return `Your call on “${task.title}”: checks unverified`;
  const failing = gate === "delivery" ? deliveryCheckWorks(task).flatMap((work) => work.checks?.results.filter((run) => checkOutcome(run).kind === "failed").map((run) => run.name) ?? []) : [];
  const unverifiedChecks = gate === "delivery" ? deliveryCheckWorks(task).flatMap((work) => work.checks?.results.filter((run) => { const kind = checkOutcome(run).kind; return kind === "incomplete" || kind === "unavailable"; }).map((run) => run.name) ?? []) : [];
  if (failing.length) return checkProblemTitle(task.title, failing, unverifiedChecks);
  const open = gate === "delivery" ? stillBlocking(task) : 0;
  if (open) return `Your call on “${task.title}”: ${open === 1 ? "1 blocking finding" : `${open} blocking findings`} still open`;
  const gap = gate === "delivery" && proofGap(task);
  if (gap) return `Your call on “${task.title}”: ${gap[0]!.toLowerCase()}${gap.slice(1)}`;
  const unverified = gate === "delivery" ? task.brief?.acceptance.filter((item) => item.verification === "blocked").length ?? 0 : 0;
  if (!unverified && gate === "delivery" && restoredAcceptance(task)) return `Your call on “${task.title}”: acceptance could not be verified`;
  return unverified ? `Your call on “${task.title}”: ${unverified === 1 ? "1 acceptance check could not be verified" : `${unverified} acceptance checks could not be verified`}` : GATE_TITLE[gate](task.title);
}

/** The status line while a check problem waits for the coordinator. */
export const CHECKS_STILL_FAIL = "Checks still fail. Your call";

/** The task's status line while a checkpoint waits on the coordinator. */
export function gateStatus(task: Task, gate: GateKind): string {
  if (gate === "plan") return "Plan ready. Waiting for your OK";
  if (gate === "design") return callOn(task, task.stageIndex) ? CALL_WORDS.waiting : "Design settled. Waiting for your check";
  if (reviewDecisionPending(task)) return "Review needs your call before final checks";
  const open = stillBlocking(task);
  const problem = gate === "delivery" ? deliveryCheckProblem(task) : checkProblem(task);
  if (problem === "failing") return CHECKS_STILL_FAIL;
  if (problem) return "Checks unverified. Your call";
  // Never "done" while Important findings are open: the rounds ran out, or acceptance repairs did, and the coordinator decides.
  const review = reviewBlocking(task).length;
  if (review) return `Review rounds ran out with ${review === 1 ? "1 blocking finding" : `${review} blocking findings`} open. Your call`;
  if (open) return "Acceptance still fails after the builder's returns. Your call";
  const gap = proofGap(task);
  if (gap) return `${gap}. Your call`;
  const unverified = task.brief?.acceptance.filter((item) => item.verification === "blocked").length ?? 0;
  if (unverified) return `${unverified === 1 ? "1 acceptance check could not be verified" : `${unverified} acceptance checks could not be verified`}. Your call`;
  if (restoredAcceptance(task)) return "Acceptance could not be verified. Your call";
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
    delete task.reviewDecision;
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
 * and Important findings still open (then the coordinator always looks before anything ships). `covered`: a pass
 * that leaves Important findings open under the coordinator's decision to continue.
 */
export type ReviewRoundEnd = { kind: "send back"; builder: number; open: number } | { kind: "passed"; covered?: number } | { kind: "used up"; open: number };

/**
 * The coordinator's decision about an exhausted review: the open Important findings it is about, and the task's own change
 * then. Acceptance failures held for the delivery decision are not the review's.
 */
export function reviewDecisionFor(task: Pick<Task, "findings" | "repositories" | "acceptanceBlocked">, stageId: Id, round: number, at: number, versions: Readonly<Record<Id, string>>): DeepMutable<NonNullable<Task["reviewDecision"]>> {
  const covers = reviewBlocking(task).map((finding) => finding.id);
  return { stageId, round, accepted: false, covers, at, versions: { ...versions } };
}

/**
 * The open Important findings the coordinator's decision to continue still covers, given the task's own change per product
 * now. A finding leaves it once there is new evidence: a reviewer confirmed or reopened it, or acceptance testing failed it
 * again, after the decision, or its products' change differs from the decided one (unavailable on either side counts as
 * changed). Only finding ids, versions and recorded times decide; findings raised later are never covered.
 */
export function coveredByDecision(task: Task, changes: Readonly<Record<Id, string>>): ReadonlySet<Id> {
  const decision = task.reviewDecision;
  if (!decision?.accepted || !decision.covers?.length || decision.at === undefined) return new Set();
  const since = decision.at;
  const unchanged = (id: Id) => {
    const decided = decision.versions?.[id];
    return !!decided && decided !== "unavailable" && changes[id] === decided;
  };
  return new Set(task.findings.filter((finding) => {
    if (!decision.covers!.includes(finding.id) || finding.status !== "open" || finding.severity !== "blocking") return false;
    if ((finding.reopenedAt ?? -Infinity) > since || (finding.reproducedAt ?? -Infinity) > since) return false;
    const owners = assignedProducts(task, finding.productIds);
    return (owners.length ? owners : taskProductIds(task)).every(unchanged);
  }).map((finding) => finding.id));
}

/**
 * A reviewer's confirmation with a current reproduction, or a repeated acceptance failure, of a finding a decision to continue
 * covers is new evidence about it. A bare id is not: callers pass only reproductions.
 */
export function noteReproduction(task: Pick<Task, "reviewDecision">, finding: DeepMutable<Finding>, at: number): void {
  if (task.reviewDecision?.covers?.includes(finding.id)) finding.reproducedAt = at;
}

/** What a passed review round leaves open, for its log line: findings a decision to continue covers are named apart, never as nothing to fix. */
export function passedOpenWords(findings: readonly Finding[], covered: ReadonlySet<Id>): string {
  const open = findings.filter((finding) => finding.status === "open");
  const others = open.filter((finding) => !covered.has(finding.id));
  const still = open.length - others.length;
  return still ? [...(others.length ? [findingCount(others)] : []), JOURNEY_WORDS.coveredOpen(still)].join("; ") : findingCount(others);
}

/** The most review rounds a stage runs on its own, however well it converges: past it the coordinator decides. */
export const MAX_REVIEW_ROUNDS = 5;

/** The Important findings a review round acts on: every open one, except acceptance failures held for the delivery decision. */
export function reviewBlocking(task: Pick<Task, "findings" | "repositories" | "acceptanceBlocked">): Task["findings"] {
  return task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking" && !exhaustedAcceptanceFailure(task, finding));
}

/** Shared convergence decision. No open findings previews whether one newly found blocker could return. */
export function allowsReviewFix(task: Task, stage: Stage, round: number): boolean {
  if (round < (stage.maxRounds ?? 2)) return true;
  const current = reviewBlocking(task);
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
 * Findings the coordinator's decision to continue still `covered` alone never send work back or use rounds up.
 */
export function reviewRoundEnd(task: Task, stage: Stage, round: number, roles: readonly Role[], covered: ReadonlySet<Id> = new Set()): ReviewRoundEnd {
  const blocking = reviewBlocking(task);
  const open = blocking.length;
  if (open === 0) return { kind: "passed" };
  if (blocking.every((finding) => covered.has(finding.id))) return { kind: "passed", covered: open };
  const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && roleForTask(roles, entry.roleId, task)?.result === "build");
  if (builder < 0) return { kind: "used up", open };
  if (allowsReviewFix(task, stage, round)) return { kind: "send back", builder, open };
  return { kind: "used up", open };
}

/** How many Important findings a review round ended with, for the next round's convergence check. */
export function noteRoundEnd(task: DeepMutable<Task>, stageId: string, open: number): void {
  task.blockingAfter = { ...(task.blockingAfter ?? {}), [stageId]: [...(task.blockingAfter?.[stageId] ?? []), open] };
  const ids = reviewBlocking(task as Task).map((finding) => finding.id);
  task.blockingFindingsAfter = { ...(task.blockingFindingsAfter ?? {}), [stageId]: [...(task.blockingFindingsAfter?.[stageId] ?? []), ids] };
}
