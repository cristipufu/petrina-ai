import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { expect, it } from "vitest";

import type { DeepMutable } from "../../../src/flow.js";
import type { State } from "../../../src/model.js";
import { removeProfile } from "../../../src/profiles.js";
import { Simulator } from "../../../src/sim.js";

const empty = () => ({ ...JSON.parse(JSON.stringify(stateFixture({ now: 1_000_000_000 }))), tasks: [], inbox: [] }) as DeepMutable<State>;

it("protects projected single-product stand-in conversations and saved builder sessions", () => {
  const state = empty();
  const task = taskFixture(state);
  state.tasks = [task]; task.state = "paused"; task.plan = undefined; task.repository = undefined; task.repositories = undefined; task.maintenance = undefined; task.agent = undefined; task.helpers = undefined;
  task.conversation = { step: "build", roleId: "builder", profileId: "fable-xhigh", toolId: "claude-code", model: "fable", sessionId: "stand-in", startedAt: 0 };
  expect(() => removeProfile(state, "fable-xhigh")).toThrow("Reassign");
  task.conversation = undefined;
  task.builderSession = { stageId: "build", profileId: "fable-xhigh", toolId: "claude-code", model: "fable", sessionId: "stand-in" };
  expect(() => removeProfile(state, "fable-xhigh")).toThrow("Reassign");
  const simulator = new Simulator(state);
  expect(() => simulator.removeProfile("fable-xhigh")).toThrow("Reassign");
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
