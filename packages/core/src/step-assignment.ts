import type { Task } from "./model.js";

/** Only planned participants receive the stage contribution; side errands keep their own job. */
export function currentStepAssignment(task: Pick<Task, "plan" | "stageIndex">, roleId: string): { title: string; body: string }[] {
  const stage = task.plan?.stages[task.stageIndex];
  if (!stage || stage.kind === "gate") return [];
  const participates = stage.kind === "review-chain"
    ? stage.profileIds.some((_, index) => (stage.roleIds?.[index] ?? stage.roleId) === roleId)
    : stage.roleId === roleId || (stage.kind === "converge" && (stage.reviewerRoleId ?? "design-reviewer") === roleId);
  if (!participates) return [];
  // Profile assignments explain selection, not task scope. Never turn those reasons or the plan's rationale into instructions.
  const title = stage.title?.trim();
  return [{
    title: "Current step assignment",
    body: `${title ? `Planned step: ${title}` : "No planned step title was recorded."}\nContribute to this step in your assigned role. The full task and approved brief remain authoritative; this step does not replace their requirements or your role's duties.`
  }];
}
