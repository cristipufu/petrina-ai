import { expect, it } from "vitest";
import { createDemoState, createDemo, createPortfolioDemo, createFirstRunDemo } from "../src/demo.js";
import { DEFAULT_PROFILES, profileConfiguration, restoreProfileCatalog } from "../src/profiles.js";
import type { DeepMutable } from "../src/flow.js";
import type { State } from "../src/model.js";

it("keeps one launch configuration per profile and every scripted plan on the shared catalog", () => {
  expect(new Set(DEFAULT_PROFILES.map(profileConfiguration)).size).toBe(DEFAULT_PROFILES.length);
  const ids = new Set(DEFAULT_PROFILES.map(profile => profile.id));
  for (const demo of [createDemo(1_000_000_000), createPortfolioDemo(1_000_000_000), createFirstRunDemo(1_000_000_000)]) {
    for (const task of demo.state.tasks) for (const stage of task.plan?.stages ?? []) {
      for (const id of [...stage.profileIds, ...stage.reviewerProfileIds ?? []]) expect(ids.has(id)).toBe(true);
    }
  }
});

it("repairs duplicate future choices while preserving actual historical identities", () => {
  const state = JSON.parse(JSON.stringify(createDemoState(1_000_000_000))) as DeepMutable<State>;
  const alias = { ...DEFAULT_PROFILES.find(profile => profile.id === "sol-high")!, id: "codex-high" };
  state.profiles.push(alias);
  const task = state.tasks[0]!;
  task.state = "paused"; task.stageIndex = 1;
  task.plan = { rationale: "Saved choices", plannerProfileId: "opus-high", stages: [0, 1].map(index => ({ id: `s${index}`, kind: "do", title: "Build", roleId: "builder", profileIds: [alias.id], assignments: [{ profileId: alias.id, by: "planner" }] })) };
  task.journey = [{ id: "old", kind: "agent", round: 1, sub: 0, startedAt: 1, profileId: alias.id }];
  state.routines = [{ id: "routine", name: "Check", enabled: true, productId: task.productId, roleId: "maintenance", profileId: alias.id, focus: "", schedule: { kind: "daily", time: "09:00" }, zone: "UTC", handledThrough: 0, nextAt: 1 }];
  restoreProfileCatalog(state);
  expect(state.profiles.some(profile => profile.id === alias.id)).toBe(false);
  expect(state.retiredProfiles).toContainEqual(alias);
  expect(task.plan.stages.map(stage => stage.profileIds[0])).toEqual([alias.id, "sol-high"]);
  expect(task.plan.stages[1]!.assignments![0]!.profileId).toBe("sol-high");
  expect(task.journey[0]!.profileId).toBe(alias.id);
  expect(state.routines[0]!.profileId).toBe("sol-high");
  const once = JSON.stringify(state);
  restoreProfileCatalog(state);
  expect(JSON.stringify(state)).toBe(once);
});
