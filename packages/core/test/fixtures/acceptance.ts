import { BUILT_IN_ROLES } from "../../src/library.js";
import type { JourneyStep, Role, Task } from "../../src/model.js";
import { stateFixture, taskFixture } from "./state.js";

export const roles: readonly Role[] = [...BUILT_IN_ROLES,
  { ...BUILT_IN_ROLES.find((role) => role.result === "checks")!, id: "custom-test", name: "Quality partner" },
  { ...BUILT_IN_ROLES.find((role) => role.result === "build")!, id: "custom-build", name: "Repair partner" },
];
export const roleFor = (id?: string) => roles.find((role) => role.id === id);
export const step = (value: Partial<JourneyStep>): JourneyStep => ({ id: "step", kind: "agent", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", ...value });

export function acceptanceFixture(roleId = "tester") {
  const task: Task = taskFixture(stateFixture({ now: 1_000_000_000_000 }));
  task.brief = { summary: "", forUsers: [], areas: [], risks: [], acceptance: [
    { text: "The total is correct", verification: "passed", met: true },
    { text: "Delivery is retained", verification: "failed", met: false },
    { text: "A real account works", verification: "blocked", reason: "Account unavailable" },
  ] };
  task.repository = { productId: task.productId, lessons: [], delivery: "pull-request", checks: { at: 20, tree: "tested-tree", current: true, results: [] } };
  delete task.repositories;
  task.journey = [step({ id: "tester", roleId, acceptanceChecks: [
    { text: "The total is correct", result: "pass", evidence: "The total includes delivery" },
    { text: "Delivery is retained", result: "fail", evidence: "Changing delivery reset the choice", reason: "Choice was lost" },
    { text: "A real account works", result: "blocked", reason: "Account unavailable" },
  ], agentResults: [{ roleId, profileId: "sol-high", at: 20, value: {}, versions: { [task.productId]: "tested-tree" } }] })];
  return task;
}
