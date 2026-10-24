import type { RepairHost } from "./ports/repair.js";
import type { RuntimeTask } from "./model.js";

/**
 * A plan that omitted delivery approval gains the delivery check before its delivery step, so evidence that must be
 * current is prepared and checked there; the task's own approval choice still applies once it is. False without a delivery step.
 */
export function addDeliveryCheck(k: Pick<RepairHost, "role">, task: RuntimeTask): boolean {
  if (task.plan!.stages.some(entry => entry.kind === "gate" && entry.gate === "delivery")) return true;
  const index = task.plan!.stages.findIndex(entry => entry.kind === "do" && k.role(entry.roleId, task)?.result === "delivery");
  if (index < 0) return false;
  const id = `${task.id}:proof-delivery`;
  task.plan!.stages.splice(index, 0, { id, title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] });
  task.proofDeliveryGate = id;
  if (task.stageIndex >= index) task.stageIndex += 1;
  return true;
}
