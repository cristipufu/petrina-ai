// The coordinator's call on a design disagreement. It is final: the architect follows it once,
// nobody reviews the design again, and the coordinator checks the brief before anything is built.
// The engine and the simulator share these rules and words so the demo cannot drift from the real thing.

import type { DesignCall, Id, Objection, Stage, Task } from "./model.js";

export const CALL_WORDS = {
  disagreement: "Read both sides in the Design tab, then side with the architect or write your call.",
  made: (text: string) => `You made the call: ${text}`,
  following: "The architect is following your call",
  updated: "The architect updated the brief to follow your call",
  revised: "The architect updated the brief to your note",
  settled: "Design settled by your call",
  waiting: "Design settled by your call. Waiting for your check",
} as const;

/** How the architect answers an open objection after a call: as the call decides it, or in its own name. */
export interface CallAnswer {
  id: Id;
  status: "accepted" | "rejected";
  answer: string;
  byCall: boolean;
}

/** The design stage a disagreement or a design check belongs to: the last one at or before `stageIndex`. */
export function designStageIndex(stages: readonly Stage[], stageIndex: number): number {
  for (let index = Math.min(stageIndex, stages.length - 1); index >= 0; index -= 1) if (stages[index]!.kind === "converge") return index;
  return -1;
}

/**
 * Write the coordinator's call on a disagreement. The task goes back to the design stage that
 * raised it, and a design check follows that stage (added for this time if the plan has none).
 */
export function startCall(task: Pick<Task, "plan" | "stageIndex" | "objections">, text: string, at: number): { stages: Stage[]; stageIndex: number; call: DesignCall } | undefined {
  const stages = task.plan?.stages ?? [];
  const index = designStageIndex(stages, task.stageIndex);
  const stage = stages[index];
  if (!stage) return undefined;
  const next = stages[index + 1];
  const check: Stage = { id: `${stage.id}:call-check`, kind: "gate", title: "Your design check", roleId: stage.roleId, profileIds: [], gate: "design" };
  return {
    stages: next?.kind === "gate" && next.gate === "design" ? [...stages] : [...stages.slice(0, index + 1), check, ...stages.slice(index + 1)],
    stageIndex: index,
    call: { text, stageId: stage.id, open: task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id), at },
  };
}

/** Where changes asked for at a design check go: the call's design stage, or the design stage before the check. */
export function designStageForChanges(task: Pick<Task, "plan" | "stageIndex" | "call">): number {
  const stages = task.plan?.stages ?? [];
  const called = task.call ? stages.findIndex((stage) => stage.id === task.call!.stageId) : -1;
  return called >= 0 ? called : designStageIndex(stages, task.stageIndex);
}

/**
 * The objections the architect answers each time it follows the call: those still open, and those
 * the call covered. Changes asked for at the check can then correct a decision, a "Your call" tag or a note.
 */
export function dueAnswers(objections: readonly Objection[], call: DesignCall): Objection[] {
  return objections.filter((objection) => objection.status === "open" || call.open.includes(objection.id));
}

/** Objections the architect owes an answer and has not given one yet. After a call, none may be left. */
export function unanswered(objections: readonly Objection[], call: DesignCall, answers: readonly Pick<CallAnswer, "id">[]): Objection[] {
  return dueAnswers(objections, call).filter((objection) => !answers.some((answer) => answer.id === objection.id));
}

/** Record the architect's answers, replacing earlier ones. Those the call decided carry the coordinator's words. No objection gets a status by default. */
export function answerByCall(objections: readonly Objection[], call: DesignCall, answers: readonly CallAnswer[]): Objection[] {
  const due = new Set(dueAnswers(objections, call).map((objection) => objection.id));
  return objections.map((objection) => {
    const answer = answers.find((entry) => entry.id === objection.id);
    if (!answer || !due.has(objection.id)) return objection;
    const next: Objection = { ...objection, status: answer.status, answer: answer.answer, call: call.text };
    if (!answer.byCall) delete next.call;
    return next;
  });
}

/** What the design check after a call says: how many objections the call settled, and how many the architect answered. */
export function callCheckBody(task: Pick<Task, "call" | "objections">): string | undefined {
  const call = task.call;
  if (!call) return undefined;
  const answered = task.objections.filter((objection) => call.open.includes(objection.id) && objection.status !== "open");
  const byCall = answered.filter((objection) => objection.call !== undefined);
  const accepted = byCall.filter((objection) => objection.status === "accepted").length;
  const own = answered.length - byCall.length;
  return [
    `Your call settled ${byCall.length} objection${byCall.length === 1 ? "" : "s"} (${accepted} accepted, ${byCall.length - accepted} rejected). The architect answered ${own === 0 ? "none" : own} on its own.`,
    "Read the updated brief and its answers in the Design tab, then approve it or request changes. Changes go to the architect only, with no review round, and it can correct any answer it gave.",
  ].join(" ");
}
