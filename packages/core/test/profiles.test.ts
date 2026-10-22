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

import { demoProfileChoices, profileModelName, saveProfile, removeProfile } from "../src/profiles.js";
const empty = () => ({ ...JSON.parse(JSON.stringify(createDemoState(1_000_000_000))), tasks: [], inbox: [] }) as DeepMutable<State>;
it("persists edited and deleted defaults while retaining historical identities", () => {
  const state = empty(); restoreProfileCatalog(state);
  const original = state.profiles.find(profile => profile.id === "sol-high")!;
  const choices = { toolId: "codex", modelId: "new-model", models: [{ id: "new-model", name: "Native model" }], efforts: ["medium" as const] };
  const draft = { toolId: "codex", modelId: "new-model", effort: "medium" as const };
  expect(saveProfile(state, draft, choices, "new-profile", original.id)).toBe("new-profile");
  expect(saveProfile(state, draft, choices, "new-profile", original.id)).toBe("new-profile");
  expect(state.retiredProfiles).toContainEqual(original);
  removeProfile(state, "sol-xhigh");
  const saved = JSON.stringify(state); restoreProfileCatalog(state); expect(JSON.stringify(state)).toBe(saved);
  expect(state.profiles.some(profile => profile.id === "sol-high" || profile.id === "sol-xhigh")).toBe(false);
});
it("rejects unsupported choices, duplicate tuples and the removal of the last planned profile", () => {
  const state = empty(), choices = demoProfileChoices("codex", "gpt-6.1-sol");
  expect(() => saveProfile(state, { toolId: "codex", modelId: choices.modelId, effort: "low" }, choices, "bad")).toThrow("supported");
  expect(() => saveProfile(state, { toolId: "codex", modelId: choices.modelId, effort: "high" }, choices, "duplicate")).toThrow("already exists");
  state.profiles = [state.profiles.find(profile => profile.id === "sol-high")!];
  expect(() => removeProfile(state, "sol-high")).toThrow("at least one");
});
it("protects unfinished repair paths and routine references, but permits history-only profiles", () => {
  const state = JSON.parse(JSON.stringify(createDemoState(1_000_000_000))) as DeepMutable<State>;
  const task = state.tasks.find(task => task.plan?.stages.some(stage => stage.profileIds.length))!;
  task.state = "paused";
  const id = task.plan!.stages.find(stage => stage.profileIds.length)!.profileIds[0]!;
  expect(() => removeProfile(state, id)).toThrow("Reassign");
  state.tasks.forEach(task => { task.state = "done"; });
  expect(() => removeProfile(state, id)).not.toThrow();
});
it("normalizes native Codex labels without combining effort variants", () => {
  expect(profileModelName(DEFAULT_PROFILES.find(p => p.id === "sol-high")!)).toBe("GPT-6.1 Sol");
  expect(profileModelName(DEFAULT_PROFILES.find(p => p.id === "astra-xhigh")!)).toBe("GPT-6 Astra");
});

import { Simulator } from "../src/sim.js";
it("protects projected single-product stand-in conversations and saved builder sessions", () => {
  const state = empty();
  const task = JSON.parse(JSON.stringify(createDemoState(1_000_000_000).tasks[0]!)) as DeepMutable<State>["tasks"][number];
  state.tasks = [task]; task.state = "paused"; task.plan = undefined; task.repository = undefined; task.repositories = undefined; task.maintenance = undefined; task.agent = undefined; task.helpers = undefined;
  task.conversation = { step: "build", roleId: "builder", profileId: "fable-xhigh", toolId: "claude-code", model: "fable", sessionId: "stand-in", startedAt: 0 };
  expect(() => removeProfile(state, "fable-xhigh")).toThrow("Reassign");
  task.conversation = undefined;
  task.builderSession = { stageId: "build", profileId: "fable-xhigh", toolId: "claude-code", model: "fable", sessionId: "stand-in" };
  expect(() => removeProfile(state, "fable-xhigh")).toThrow("Reassign");
  const simulator = new Simulator(state);
  expect(() => simulator.removeProfile("fable-xhigh")).toThrow("Reassign");
});
it("protects selected verifier profiles while waiting, including the projected task", () => {
  const state = empty();
  const task = JSON.parse(JSON.stringify(createDemoState(1_000_000_000).tasks[0]!)) as DeepMutable<State>["tasks"][number];
  state.tasks = [task]; task.state = "waiting"; task.plan = undefined; task.agent = undefined; task.helpers = undefined;
  task.conversation = undefined; task.builderSession = undefined; task.repository = undefined; task.repositories = undefined;
  task.hunt = { stageId: "review", round: 1, reported: {}, findings: 1, voterProfiles: ["grok-high"] };
  expect(() => removeProfile(state, "grok-high")).toThrow("Reassign");
  task.state = "cancelled";
  expect(() => removeProfile(state, "grok-high")).not.toThrow();
});
it("keeps the demo planner on an active non-standby profile after edits and removal", async () => {
  const state = empty(); state.planner = "opus-high";
  const simulator = new Simulator(state);
  await simulator.saveProfile({ toolId: "claude-code", modelId: "opus", effort: "medium" }, "edited", "opus-high");
  const planner = simulator.getState().planner!;
  expect(planner).not.toBe("opus-high");
  expect(simulator.getState().profiles.some(profile => profile.id === planner && !profile.standby)).toBe(true);
  simulator.removeProfile(planner);
  expect(simulator.getState().planner).not.toBe(planner);
  expect(simulator.getState().profiles.some(profile => profile.id === simulator.getState().planner && !profile.standby)).toBe(true);
});
