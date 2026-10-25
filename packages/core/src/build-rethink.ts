import type { Task } from "./model.js";

export function reviewRound(task: Task): number {
  const stage = task.plan?.stages.find((entry, index) => entry.kind === "review-chain" && index >= task.stageIndex) ?? task.plan?.stages.findLast((entry) => entry.kind === "review-chain");
  return (stage && task.rounds[stage.id]) || 1;
}

export function stepBack(task: Task): boolean {
  return reviewRound(task) > 3;
}

export function freshBuilderRethink(task: Task, own: Task["builderSession"], stageId: string, plannedId: string): boolean {
  return !!task.fixing && stepBack(task) && !(own?.stageId === stageId && (own.plannedProfileId ?? own.profileId) === plannedId && own.rethought);
}
