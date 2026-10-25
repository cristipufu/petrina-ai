import type { Task } from "./model.js";

/** A conversation belongs to this stage, round and position, including a fix round. */
export function stepKey(task: Pick<Task, "stageIndex" | "plan" | "rounds" | "sub" | "fixing">): string {
  if (task.stageIndex < 0) return "plan";
  const stage = task.plan?.stages[task.stageIndex];
  return `${stage?.id ?? task.stageIndex} round ${stage ? (task.rounds[stage.id] ?? 1) : 1} position ${task.sub}${task.fixing ? " fixing" : ""}`;
}
