import { roleForTask } from "./roles.js";
import { hintProducts } from "./repositories.js";
import type { Id, Role, Task } from "./model.js";

/** Advice comes only from the latest settling design review, never from older or answered points. */
export function finalDesignNotes(task: Task, roles: readonly Role[]): { title: string; body: string }[] {
  const kind = (roleId: Id | undefined) => roleId === undefined ? undefined : roleForTask(roles, roleId, task)?.result;
  const last = task.journey?.findLast((step) => step.kind === "agent" && (kind(step.roleId) === "brief" || kind(step.roleId) === "objections"));
  const raised = last && kind(last.roleId) === "objections" ? last.result?.objections : undefined;
  if (!last || !raised || raised.some((objection) => objection.blocking)) return [];
  const notes = task.objections.filter((objection) => objection.status === "noted" && !objection.blocking && objection.round === last.round && raised.some((entry) => entry.id === objection.id));
  if (!notes.length) return [];
  const step = task.plan?.stages.find((stage) => stage.id === last.stageId)?.title ?? "an earlier design step";
  const reviewer = roleForTask(roles, last.roleId!, task)!.name;
  return [{
    title: "Final design-review notes (advice only)",
    body: `From “${step}”, round ${last.round}, by ${reviewer}: the design settled with these non-blocking points noted. They are advice only, not requirements, acceptance items or blockers. Check each one against the current code before relying on it. The approved brief, the coordinator's notes and any design call win wherever they differ. Do not add scope because of a note, and you need not answer them.${hintProducts(task).length > 1 ? " This task has several products, so some notes may concern another product." : ""}\n${notes.map((note) => `- ${note.text}`).join("\n")}`,
  }];
  }
