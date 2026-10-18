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
