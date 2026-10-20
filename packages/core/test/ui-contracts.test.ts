import { describe, expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import { designCheckIndex, startCall } from "../src/call.js";
import { historyItem } from "../src/history.js";
import { blocksDependents } from "../src/repositories.js";
import { readyQueue, startsNextCount } from "../src/scheduler.js";
import { Simulator } from "../src/sim.js";
import { JOURNEY_WORDS as W } from "../src/journey.js";
import { reviewStats } from "../src/reviews.js";
import type { Role, Stage, State, Task } from "../src/model.js";

const initial = createDemoState(1_000_000_000);
const template = initial.tasks[0]!;
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

  it.each(["pull-request", "release"] as const)("runs custom build/checks/delivery roles through the demo for %s", delivery => {
    const roles = [...initial.roles, custom("build"), custom("checks"), custom("delivery")];
    const simulator = new Simulator({ ...initial, roles, tasks: [], inbox: [], pool: { ...initial.pool, paused: true } });
    const id = simulator.addTask({ productId: initial.products[0]!.id, title: "Custom workflow", kind: "chore", delivery, approvePlan: false, approveDelivery: false });
    const task = simulator.getState().tasks.find(task => task.id === id)!;
    Object.assign(task, { state: "waiting", stageIndex: 0, fixing: true, plan: { rationale: "Custom roles", plannerProfileId: "opus-high", stages: ["build", "checks", "delivery"].map(result => ({ id: result, roleId: `custom-${result}`, kind: "do", title: result, profileIds: ["opus-high"] })) }, findings: [{ id: "bug", text: "A confirmed bug", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] }] });
    simulator.setPoolPaused(false);
    for (let tick = 0; tick < 100 && !["done", "pr-open"].includes(simulator.getState().tasks[0]!.state); tick++) simulator.tick();
    const finished = simulator.getState().tasks[0]!;
    expect(["done", "pr-open"]).toContain(finished.state);
    expect(finished.findings[0]!.status).toBe("fixed");
    expect(finished.journey!.find(step => step.roleId === "custom-build")?.outcome).toBe(W.fixed(1));
    expect(finished.journey!.find(step => step.roleId === "custom-checks")?.outcome).toBe(W.checks(0, finished.brief?.acceptance.length ?? 0));
    expect(finished.journey!.some(step => step.kind === "agent" && step.roleId === "custom-delivery")).toBe(delivery === "release");
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
