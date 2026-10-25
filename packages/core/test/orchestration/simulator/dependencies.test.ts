import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS, Simulator, createTaskState, type State } from "../../../src/index.js";

function fixture(paused = true) {
  const state: State = { now: 1000, seq: 0, products: [{ id: "p", name: "Product", repo: "local/product", tone: "blue" }], roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS, tasks: [], inbox: [], pool: { limit: 2, paused, toolCaps: {} } };
  const sim = new Simulator(state);
  const add = (title: string) => sim.addTask({ productId: "p", title, backlog: true });
  return { sim, add };
}

describe("prerequisites saved with a request", () => {
  it("validates creation against the same graph before exposing any task", () => {
    const { sim, add } = fixture();
    const a = add("First"), b = add("Second");
    const before = sim.getState();
    expect(() => sim.addTask({ productId: "p", title: "Invalid", after: [a, "removed"] })).toThrow("Remove");
    expect(sim.getState()).toBe(before);
    const products = before.products;
    expect(() => createTaskState({ productId: "p", title: "Self", after: ["new"] }, products, { id: "new", now: 0, timelineId: "line", priority: 0 })).toThrow("itself");
    const chain = { id: "chain", after: ["new"] };
    expect(() => createTaskState({ productId: "p", title: "Cycle", after: ["chain"] }, products, { id: "new", now: 0, timelineId: "line", priority: 0 }, () => chain)).toThrow("each other");
    const id = sim.addTask({ productId: "p", title: "Valid", after: [a, b, a], backlog: true, clientId: "same-request" });
    expect(sim.taskDetails(id)!.after).toEqual([a, b]);
    expect(sim.addTask({ productId: "p", title: "Valid", after: [a, b], backlog: true, clientId: "same-request" })).toBe(id);
  });

  it("remembers Backlog choices without a wait, including edits and a restart, then waits only when queued", () => {
    const { sim, add } = fixture();
    const a = add("First"), b = add("Second");
    const id = sim.addTask({ productId: "p", title: "Draft", after: [a], backlog: true });
    sim.setAfter(id, [a, b]);
    expect(sim.taskDetails(id)!.journey).toBeUndefined();
    expect(sim.taskDetails(id)!.statusLine).toBe("Review the request before queueing");
    expect(sim.taskDetails(id)!.timeline.at(-1)!.text).toContain("First");
    const restarted = new Simulator(JSON.parse(JSON.stringify(sim.getState())));
    restarted.queueTask(id);
    expect(restarted.taskDetails(id)!.after).toEqual([a, b]);
    expect(restarted.taskDetails(id)!.journey?.[0]).toMatchObject({ kind: "wait", waitsOn: [{ id: a, title: "First" }, { id: b, title: "Second" }] });
    restarted.moveToBacklog(id);
    expect(restarted.taskDetails(id)!.journey?.at(-1)!.endedAt).toBeDefined();
    restarted.setAfter(id, []);
    expect(restarted.taskDetails(id)!.statusLine).toBe("Review the request before queueing");
    restarted.queueTask(id);
    expect(restarted.taskDetails(id)!.journey).toHaveLength(1);
  });

  it("cannot start at creation or after one landing while another prerequisite still blocks", () => {
    const { sim, add } = fixture(false);
    const a = add("First"), b = add("Second");
    const id = sim.addTask({ productId: "p", title: "Follow both", after: [a, b] });
    expect(sim.taskDetails(id)!.startedAt).toBeUndefined();
    const withLanding = JSON.parse(JSON.stringify(sim.getState())) as State;
    const first = { ...withLanding.tasks.find((task) => task.id === a)!, state: "done" as const, pr: { number: 1, url: "https://example.test/1", state: "merged" as const, openedAt: 0 } };
    const oneLanded = new Simulator({ ...withLanding, tasks: withLanding.tasks.map((task) => task.id === a ? first : task) });
    oneLanded.tick();
    expect(oneLanded.taskDetails(id)!.startedAt).toBeUndefined();
    expect(oneLanded.taskDetails(id)!.journey![0]!.endedAt).toBeUndefined();
    oneLanded.cancel(b);
    expect(oneLanded.taskDetails(id)!.startedAt).toBeDefined();
    expect(oneLanded.taskDetails(id)!.journey![0]!.outcome).toContain("did not land: cancelled");
    expect(oneLanded.taskDetails(id)!.journey![0]!.outcome).toContain("First");
    expect(() => oneLanded.setAfter(id, [])).toThrow("already started");
    expect(oneLanded.taskDetails(id)!.after).toEqual([a, b]);
  });

  it("does not invent a wait when all prerequisites already landed and keeps priority and holds independent", () => {
    const { sim, add } = fixture();
    const a = add("First"), b = add("Second");
    const id = sim.addTask({ productId: "p", title: "Waiting", after: [a, b] });
    sim.setHeld(id, true);
    sim.moveToTop(id);
    expect(sim.taskDetails(id)!.after).toEqual([a, b]);
    const priority = sim.taskDetails(id)!.priority;
    sim.setAfter(id, [b]);
    expect(sim.taskDetails(id)).toMatchObject({ held: true, priority, after: [b] });
    sim.cancel(b);
    expect(sim.taskDetails(id)!.journey![0]!.endedAt).toBeDefined();
    const landed = new Simulator({ ...sim.getState(), tasks: sim.getState().tasks.map((task) => [a, b].includes(task.id) ? { ...task, state: "done", pr: { number: 1, url: "https://example.test/1", state: "merged", openedAt: 1 } } : task) });
    const draft = landed.addTask({ productId: "p", title: "No blocker", backlog: true, after: [a, b] });
    landed.queueTask(draft);
    expect(landed.taskDetails(draft)!.journey).toBeUndefined();
    sim.setAfter(id, []);
    expect(sim.taskDetails(id)).toMatchObject({ held: true, priority, after: [] });
  });
});
