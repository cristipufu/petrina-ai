import { expect, it } from "vitest";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

it("keeps canonical catalogs, explicit overrides and separate fixtures independently writable", () => {
  const source = stateFixture(), before = JSON.stringify(source);
  const first = stateFixture(source), second = stateFixture(source);
  first.products[0]!.name = "Changed product";
  first.roles[0]!.instructions = "Changed instructions";
  first.profiles[0]!.model = "Changed model";
  first.pool.toolCaps.codex = 1;
  first.tasks.push(taskFixture(first));
  expect(JSON.stringify(source)).toBe(before);
  expect(second).toEqual(source);
  expect(stateFixture()).toEqual(source);
});

it("keeps nested task overrides private across repeated task construction", () => {
  const state = stateFixture(), plan = { rationale: "Isolated", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] },
  ] };
  const first = taskFixture(state, { plan }), second = taskFixture(state, { plan });
  first.plan!.stages[0]!.profileIds.push("opus-high");
  first.selectedProducts![0]!.delivery = "release";
  expect(second.plan).toEqual(plan);
  expect(plan.stages[0]!.profileIds).toEqual(["sol-high"]);
  expect(second.selectedProducts![0]!.delivery).toBe("pull-request");
  expect(state.tasks).toEqual([]);
});
