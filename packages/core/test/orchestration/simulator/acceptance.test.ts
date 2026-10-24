import { expect, it } from "vitest";
import { acceptanceSummary } from "../../../src/acceptance.js";
import { displayTask } from "../../../src/repositories.js";
import { Simulator } from "../../../src/sim.js";
import { stateFixture } from "../../fixtures/state.js";
import { acceptanceFixture as fixture, roles, roleFor } from "../../fixtures/acceptance.js";

it("the simulator records a custom Builder and Tester's versions and acceptance separately from commands", () => {
  const state = stateFixture({ now: 1_000_000_000_000 });
  const task = displayTask(fixture("custom-test"));
  task.plan = { rationale: "", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "custom-build", profileIds: ["sol-high"] },
    { id: "test", kind: "do", title: "Test", roleId: "custom-test", profileIds: ["sol-high"] },
    { id: "deliver", kind: "gate", title: "Delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
  ] };
  Object.assign(task, { state: "waiting", column: "building", stageIndex: 0, sub: 0, rounds: {}, journey: [], findings: [], checks: undefined, agent: undefined, holdsSlot: false });
  const sim = new Simulator({ ...state, tasks: [task], inbox: [], roles, pool: { limit: 1, paused: false, toolCaps: {} } });
  for (let tick = 0; tick < 50 && !sim.getState().inbox.some((item) => item.kind === "delivery"); tick++) sim.tick();
  const completed = sim.getState().tasks[0]!;
  const build = completed.journey!.find((step) => step.roleId === "custom-build")!;
  const tester = completed.journey!.find((step) => step.roleId === "custom-test")!;
  expect(build.buildVersions?.[task.productId]).toBeDefined();
  expect(tester.acceptanceChecks).toHaveLength(3);
  expect(tester.agentResults![0]!.versions).toEqual(build.buildVersions);
  expect(completed.journey!.filter((step) => step.work === "checks")).toHaveLength(1);
  expect(completed.journey!.find((step) => step.work === "checks")!.acceptanceChecks).toBeUndefined();
  expect(acceptanceSummary(completed, roleFor).current).toBe(true);
});
