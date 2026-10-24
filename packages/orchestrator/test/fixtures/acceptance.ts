import { BUILT_IN_ROLES, finishTaskStep, roleForTask } from "@petrina/core";
import type { AcceptanceRoutingHost, RuntimeTask } from "../../src/index.js";
import { repairTask } from "./tasks.js";

export function acceptanceTask(shared = true, gate = true): RuntimeTask {
  const task = repairTask(shared);
  task.plan = { rationale: "Acceptance before owed reviews and delivery", plannerProfileId: "planner", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["builder"] },
    { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["tester"] },
    { id: "review", title: "Code review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["reviewer"] },
    { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["security"] },
    ...(gate ? [{ id: "delivery-check", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] }] : []),
    { id: "delivery", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["release"] },
  ] };
  task.stageIndex = 1;
  return task;
}

export function acceptanceHost() {
  const events: { kind: "finish" | "note" | "now" | "deferred" | "decision"; taskId: string; stage: number; tone?: "warn" | "milestone"; text?: string }[] = [];
  const checkpoints: RuntimeTask[] = [];
  const host: AcceptanceRoutingHost = {
    role: (id, task) => roleForTask(BUILT_IN_ROLES, id, task),
    finishStep(scope) { finishTaskStep(scope.task, scope.work, 200); events.push({ kind: "finish", taskId: scope.task.id, stage: scope.task.stageIndex }); },
    note(scope, tone, text) { events.push({ kind: "note", taskId: scope.task.id, stage: scope.task.stageIndex, tone, text }); },
    commitNow(task) { checkpoints.push(structuredClone(task)); events.push({ kind: "now", taskId: task.id, stage: task.stageIndex }); },
    commit(task) { checkpoints.push(structuredClone(task)); events.push({ kind: "deferred", taskId: task.id, stage: task.stageIndex }); },
    openDeliveryDecision(task) { events.push({ kind: "decision", taskId: task.id, stage: task.stageIndex }); },
  };
  return { host, events, checkpoints };
}

export function acceptanceFailure(task: RuntimeTask, products: string[] = ["b"]): void {
  task.findings.push({ id: "acceptance-failure", text: "Failed acceptance check: A greeting file exists", productIds: products, severity: "blocking", raisedBy: "tester", confirmedBy: [], status: "open" });
}
