// The coordinator's call on a design disagreement. It is final: the architect follows it,
// nobody reviews that design again, and the coordinator checks the brief before anything is built.
// The call stays on the task, so no later design check can reopen the design it settled.
// The engine and the simulator share these rules and words so the demo cannot drift from the real thing.

import type { DesignCall, Id, Objection, Role, Stage, Task } from "./model.js";

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
 * The design check that belongs to the design stage at `designIndex`: the first one after it, with only
 * steps such as Screens in between. A check after the build, or after another design stage, is not its own.
 */
export function designCheckIndex(stages: readonly Stage[], designIndex: number, roles: readonly Pick<Role, "id" | "result">[]): number {
  for (let index = designIndex + 1; index < stages.length; index += 1) {
    const stage = stages[index]!;
    if (stage.kind === "gate" && stage.gate === "design") return index;
    if (stage.kind !== "do" || roles.find(role => role.id === stage.roleId)?.result === "build") return -1;
  }
  return -1;
}

/**
 * Write the coordinator's call on a disagreement. The task goes back to the design stage that raised it.
 * The plan's own design check for that stage is the one the coordinator answers; one is added right after
 * the stage only if the plan has none before the build.
 */
export function startCall(task: Pick<Task, "plan" | "stageIndex" | "objections">, text: string, at: number, roles: readonly Pick<Role, "id" | "result">[]): { stages: Stage[]; stageIndex: number; call: DesignCall } | undefined {
  const stages = task.plan?.stages ?? [];
  const index = designStageIndex(stages, task.stageIndex);
  const stage = stages[index];
  if (!stage) return undefined;
  const check: Stage = { id: `${stage.id}:call-check`, kind: "gate", title: "Your design check", roleId: stage.roleId, profileIds: [], gate: "design" };
  return {
    stages: designCheckIndex(stages, index, roles) >= 0 ? [...stages] : [...stages.slice(0, index + 1), check, ...stages.slice(index + 1)],
    stageIndex: index,
    call: { text, stageId: stage.id, open: task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id), at },
  };
}

/** The call that settled the design the stage at `stageIndex` belongs to (that design stage, or a check after it), if there is one. */
export function callOn(task: Pick<Task, "plan" | "call">, stageIndex: number): DesignCall | undefined {
  const stages = task.plan?.stages ?? [];
  const design = stages[designStageIndex(stages, stageIndex)];
  return design && task.call?.stageId === design.id ? task.call : undefined;
}

/** The call the architect follows: set while the task is at the very design stage the call settled. */
export function followingCall(task: Pick<Task, "plan" | "stageIndex" | "call">): DesignCall | undefined {
  return task.plan?.stages[task.stageIndex]?.kind === "converge" ? callOn(task, task.stageIndex) : undefined;
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

/** What a design check on a design the call settled says: how many objections the call settled, and how many the architect answered. */
export function callCheckBody(task: Pick<Task, "plan" | "stageIndex" | "call" | "objections">): string | undefined {
  const call = callOn(task, task.stageIndex);
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
