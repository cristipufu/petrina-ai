import { BUILT_IN_ROLES, createTaskState, roleForTask, type Product } from "@petrina/core";
import type { RepairHost, RuntimeTask } from "../../src/index.js";

const products: readonly Product[] = [
  { id: "a", name: "Shop", repo: "local/shop", tone: "blue" },
  { id: "b", name: "API", repo: "local/api", tone: "green" },
];

/** Data only: use the production initializer, with explicit identity and canonical owners. */
export function repositoryTask(shared = true): RuntimeTask {
  const task = createTaskState({ productId: "a", title: "Repair the affected products", backlog: true }, products,
    { id: "task", timelineId: "created", now: 100, priority: 0 });
  if (shared) task.repositories = products.map(({ id }) => ({ productId: id, delivery: "pull-request", completedStages: [] }));
  else task.repository = { productId: "a", delivery: "local" };
  return task;
}

export function repairTask(shared = true): RuntimeTask {
  const task = repositoryTask(shared);
  task.plan = { rationale: "Focused repair", plannerProfileId: "planner", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["builder"] },
    { id: "test", kind: "do", title: "Test", roleId: "tester", profileIds: ["tester"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["reviewer"] },
  ] };
  task.stageIndex = 2;
  return task;
}

/** A checkpoint captures the actual handed-over state; it does not pretend to exercise SQLite. */
export function repairHost() {
  const checkpoints: RuntimeTask[] = [];
  const roles: { id: string; task: RuntimeTask }[] = [];
  const host: RepairHost = {
    role(id, task) { roles.push({ id, task }); return roleForTask(BUILT_IN_ROLES, id, task); },
    commitNow(task) { checkpoints.push(structuredClone(task)); },
  };
  return { host, checkpoints, roles };
}
