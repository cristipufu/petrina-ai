import { workflowFixture } from "../../fixtures/workflow.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { expect, it } from "vitest";

import { DEFAULT_PROFILES, restoreProfileCatalog } from "../../../src/profiles.js";
import type { DeepMutable } from "../../../src/flow.js";
import type { State } from "../../../src/model.js";
import { demoProfileChoices, profileModelName, saveProfile, removeProfile } from "../../../src/profiles.js";

const empty = () => ({ ...JSON.parse(JSON.stringify(stateFixture({ now: 1_000_000_000 }))), tasks: [], inbox: [] }) as DeepMutable<State>;

it("repairs duplicate future choices while preserving actual historical identities", () => {
  const state = JSON.parse(JSON.stringify(stateFixture({ now: 1_000_000_000 }))) as DeepMutable<State>;
  const alias = { ...DEFAULT_PROFILES.find(profile => profile.id === "sol-high")!, id: "codex-high" };
  state.profiles.push(alias);
  const task = taskFixture(state); state.tasks.push(task);
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
  const state = JSON.parse(JSON.stringify(stateFixture({ now: 1_000_000_000 }))) as DeepMutable<State>;
  const task = taskFixture(state, { plan: workflowFixture().task.plan }); state.tasks.push(task);
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

it("protects selected verifier profiles while waiting, including the projected task", () => {
  const state = empty();
  const task = taskFixture(state);
  state.tasks = [task]; task.state = "waiting"; task.plan = undefined; task.agent = undefined; task.helpers = undefined;
  task.conversation = undefined; task.builderSession = undefined; task.repository = undefined; task.repositories = undefined;
  task.hunt = { stageId: "review", round: 1, reported: {}, findings: 1, voterProfiles: ["grok-high"] };
  expect(() => removeProfile(state, "grok-high")).toThrow("Reassign");
  task.state = "cancelled";
  expect(() => removeProfile(state, "grok-high")).not.toThrow();
});

it("seeds default profiles for newly introduced tools on a saved catalog without resurrecting edited or removed tools", () => {
  const state = empty();
  restoreProfileCatalog(state);
  removeProfile(state, "sol-xhigh");
  state.profiles = state.profiles.filter(
    (profile) => profile.toolId !== "opencode" && profile.toolId !== "pi" && profile.toolId !== "grok",
  );
  state.retiredProfiles = [
    ...(state.retiredProfiles ?? []),
    ...DEFAULT_PROFILES.filter((profile) => profile.toolId === "grok"),
  ];

  restoreProfileCatalog(state);

  expect(state.profiles.some((profile) => profile.toolId === "opencode")).toBe(true);
  expect(state.profiles.some((profile) => profile.toolId === "pi")).toBe(true);
  expect(state.profiles.some((profile) => profile.id === "sol-xhigh")).toBe(false);
  expect(state.profiles.some((profile) => profile.toolId === "grok")).toBe(false);
});
