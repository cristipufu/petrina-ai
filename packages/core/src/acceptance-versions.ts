import type { DeepMutable } from "./flow.js";
import type { Task } from "./model.js";

/** Whether applying shared version observations can change saved evidence. */
export function hasAcceptanceVersionConsumers(task: Pick<Task, "repositories" | "brief">): boolean {
  return !!task.repositories && (task.repositories.some(work => !!work.checks)
    || !!task.brief?.acceptance.some(item => item.verification === "passed" && !!item.versions && Object.keys(item.versions).length > 0));
}

/** Apply already observed code identities; native observation remains owned by the caller. */
export function applyAcceptanceVersions(task: DeepMutable<Pick<Task, "repositories" | "brief" | "acceptancePassed">>, current: Readonly<Record<string, string>>): void {
  if (!task.repositories) return;
  for (const work of task.repositories) if (work.checks) work.checks.current = work.checks.tree === current[work.productId];
  if (!task.brief) return;
  let changed = false;
  for (const item of task.brief.acceptance) {
    if (item.verification !== "passed" || !item.versions) continue;
    if (Object.entries(item.versions).some(([id, version]) => current[id] !== version)) {
      delete item.met;
      item.verification = "stale";
      item.reason = "An affected product changed after this acceptance check. Combined verification is required again.";
      changed = true;
    }
  }
  if (changed) task.acceptancePassed = false;
}
