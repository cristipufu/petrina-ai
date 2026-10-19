import { describe, expect, it } from "vitest";
import { boardSections, createDemoState, journeyView, pipelineOf, queueOf, Simulator } from "../src/index.js";

describe("requests awaiting a coordinator's review", () => {
  it("keeps backlog requests out of the queue and every agent slot, even after ticks and a restart", () => {
    const base = createDemoState(1_000_000_000);
    let sim = new Simulator({ ...base, tasks: [], inbox: [], pool: { ...base.pool, paused: false } });
    const id = sim.addTask({ productId: base.products[0]!.id, title: "Draft request", description: "Check the scope first", backlog: true });
    for (let tick = 0; tick < 10; tick += 1) sim.tick();
    sim = new Simulator(JSON.parse(JSON.stringify(sim.getState())));
    const task = sim.taskDetails(id)!;
    expect(task.state).toBe("backlog");
    expect(task.startedAt).toBeUndefined();
    expect(queueOf(sim.getState().tasks)).toEqual([]);
    expect(boardSections(sim.getState().tasks).backlog.map((entry) => entry.id)).toEqual([id]);
    expect(pipelineOf(task)).toEqual([]);
    const state = sim.getState();
    const view = journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox });
    expect(view.start.kind).toBe("backlog");
    expect(view.nodes).toEqual([]);
    expect(view.rest).toBeUndefined();
    sim.updateBacklog(id, { title: "Reviewed request", description: "Clear requirements" });
    sim.setPoolPaused(true);
    sim.queueTask(id);
    sim.queueTask(id);
    expect(queueOf(sim.getState().tasks).map((entry) => entry.id)).toEqual([id]);
    expect(sim.taskDetails(id)!.title).toBe("Reviewed request");
    sim.moveToBacklog(id);
    expect(sim.taskDetails(id)!.state).toBe("backlog");
    sim.queueTask(id);
    sim.setPoolPaused(false);
    expect(sim.taskDetails(id)!.startedAt).toBeDefined();
    sim.moveToBacklog(id);
    expect(sim.taskDetails(id)!.state).not.toBe("backlog");
    expect(() => sim.updateBacklog(id, { title: "Too late", description: "" })).toThrow("Only backlog requests");
  });
});

it("combines compatible unstarted requests once, preserving requirements and the stricter approvals", async () => {
  const state = createDemoState(1_000_000_000);
  const sim = new Simulator({ ...state, tasks: [], inbox: [], pool: { ...state.pool, paused: true } });
  const first = sim.addTask({ productId: state.products[0]!.id, title: "Fix the label", description: "Use plain words.", kind: "chore", approveDelivery: false, backlog: true });
  const second = sim.addTask({ productId: state.products[0]!.id, title: "Fix the space", description: "Keep the focus outline.", kind: "chore", approvePlan: true, approveDelivery: true, backlog: true });
  const id = await sim.combineBacklog([first, second], "Polish the form", "combine-once");
  expect(await sim.combineBacklog([first, second], "Polish the form", "combine-once")).toBe(id);
  expect(queueOf(sim.getState().tasks).map((task) => task.id)).toEqual([id]);
  expect(sim.taskDetails(id)).toMatchObject({ state: "queued", approvePlan: true, approveDelivery: true, kind: "chore", combinedFrom: [{ id: first, title: "Fix the label" }, { id: second, title: "Fix the space" }] });
  expect(sim.taskDetails(id)!.description).toContain("Use plain words.");
  expect(sim.taskDetails(id)!.description).toContain("Keep the focus outline.");
  expect(sim.taskDetails(first)).toMatchObject({ state: "cancelled", combinedInto: id });
  const other = sim.addTask({ productId: state.products[1]!.id, title: "Other product", backlog: true });
  const same = sim.addTask({ productId: state.products[0]!.id, title: "Same product", backlog: true });
  await expect(sim.combineBacklog([other, same], "Incompatible", "no")).rejects.toThrow("same products");
  expect(sim.taskDetails(other)!.state).toBe("backlog");
  expect(sim.taskDetails(same)!.state).toBe("backlog");
  await expect(sim.combineBacklog([same, same], "Duplicate", "no")).rejects.toThrow("different backlog");
  sim.setAfter(same, [other]);
  await expect(sim.combineBacklog([other, same], "Dependency", "no")).rejects.toThrow("dependencies");
});
