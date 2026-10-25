import { beginAgentStep, endAgentStep, type JourneyTask } from "../../src/journey.js";
import type { Task } from "../../src/model.js";
import { stateFixture, taskFixture } from "./state.js";
import { workflowFixture } from "./workflow.js";

export function journeyState(limit = 2) {
  return stateFixture({ now: 0, products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue", delivery: "pull-request", approveDelivery: true }], pool: { limit, paused: false, toolCaps: {} }, planner: "sonnet-medium" });
}

/** Shared record helpers create a completed Planner and current Builder, with no simulated prior work. */
export function recordedBuild(): Task & JourneyTask {
  const state = journeyState();
  const task = taskFixture(state, { id: "saved-carts", title: "Saved carts", kind: "bug", state: "running", column: "building", startedAt: 0, holdsSlot: true, approvePlan: false, stageIndex: -1, plan: workflowFixture().task.plan, journey: [], agent: { roleId: "builder", profileId: "opus-high", since: 1, step: 0 } });
  beginAgentStep(task, "planner", "sonnet-medium", 0, state.roles);
  endAgentStep(task, { outcome: "Plan ready", reason: "plan ready" }, 1);
  task.stageIndex = 0;
  beginAgentStep(task, "builder", "opus-high", 1, state.roles);
  return task;
}

export function planningJourney() {
  const state = journeyState();
  const task = taskFixture(state, { id: "greeting", title: "Greeting", kind: "feature", state: "running", column: "planning", startedAt: 0, holdsSlot: true, agent: { roleId: "planner", profileId: "sonnet-medium", since: 0, step: 0 }, statusLine: "Planner is starting", journey: [] });
  beginAgentStep(task, "planner", "sonnet-medium", 0, state.roles);
  state.tasks.push(task);
  return { state, task };
}
