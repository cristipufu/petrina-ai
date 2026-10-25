import { describe, expect, it } from "vitest";
import { workflowFixture } from "../../fixtures/workflow.js";
import { displayTask } from "../../../src/repositories.js";
import { designCheckIndex, startCall } from "../../../src/call.js";
import { historyItem } from "../../../src/history.js";
import { blocksDependents } from "../../../src/repositories.js";
import { readyQueue, startsNextCount } from "../../../src/scheduler.js";

import { reviewStats } from "../../../src/reviews.js";
import type { Role, Stage, State, Task } from "../../../src/model.js";

const { state: initial, task: stored } = workflowFixture();
const template = displayTask(stored);

const custom = (result: Role["result"]) => ({ ...initial.roles.find(role => role.result === result)!, id: `custom-${result}`, name: `Custom ${result}`, added: true });

describe("role contracts and queued work", () => {
  it("stops a design gate search at any build-result role, while permitting a notes role named builder", () => {
    const roles = [custom("build"), { ...custom("notes"), id: "builder" }];
    const design: Stage = { id: "design", kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"] };
    const check: Stage = { id: "check", kind: "gate", gate: "design", roleId: "architect", title: "Design check", profileIds: [] };
    const build: Stage = { id: "build", kind: "do", title: "Build", roleId: "custom-build", profileIds: ["opus-high"] };
    expect(designCheckIndex([design, build, check], 0, roles)).toBe(-1);
    expect(designCheckIndex([design, { ...build, roleId: "builder" }, check], 0, roles)).toBe(2);
    const task = { ...template, stageIndex: 0, plan: { ...template.plan!, stages: [design, build, check] } };
    expect(startCall(task, "Follow this decision", initial.now, roles)!.stages.map(stage => stage.id)).toEqual(["design", "design:call-check", "build", "check"]);
  });

  it("excludes held and dependency-blocked tasks from every next-start calculation", () => {
    const blocked: Task = { ...template, id: "blocked", state: "queued", holdsSlot: false, priority: 0, after: ["dependency"], held: false };
    const ready: Task = { ...blocked, id: "ready", priority: 2, after: [] };
    const dependency: Task = { ...template, id: "dependency", state: "done", holdsSlot: false, repositories: [{ productId: "shop", delivery: "pull-request", completedStages: [], pr: { number: 1, url: "https://github.com/acme/shop/pull/1", state: "open", openedAt: 1 } }] };
    const state: State = { ...initial, tasks: [blocked, { ...ready, id: "held", held: true, priority: 1 }, ready, dependency], pool: { ...initial.pool, paused: false, limit: 8 } };
    expect(blocksDependents(dependency)).toBe(true); expect(readyQueue(state).map(task => task.id)).toEqual(["ready"]); expect(startsNextCount(state)).toBe(1);
    state.history = { revision: 1, total: 1, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [], dependencies: [{ ...historyItem(dependency), blocksDependents: true }] };
    state.tasks = state.tasks.filter(task => task.id !== dependency.id);
    expect(readyQueue(state).map(task => task.id)).toEqual(["ready"]);
    state.history.dependencies = [{ ...historyItem(dependency), blocksDependents: false }];
    expect(readyQueue(state).map(task => task.id)).toEqual(["blocked", "ready"]);
  });
});
