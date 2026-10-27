import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { heldPlanning } from "../../fixtures/state-admission.js";
import { afterAll, describe, expect, it } from "bun:test";


import { join } from "node:path";
import { journeyProblems } from "@petrina/core";
import { waitFor } from "../../fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

describe("Tasks that start after others land", () => {
  it("waits quietly until the tasks it waits for land, and refuses loops", async () => {
    return cases.use("petrina-after-", async owner => {
      const engine = owner.open(join(owner.root, "data"), heldPlanning());
      engine.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue" });
      await engine.waitUntilReady();
    const productId = "product";
    engine.setPoolPaused(true);
    const first = engine.addTask({ productId, title: "Lay the groundwork", description: "First.", kind: "feature" });
    engine.setHeld(first, true);
    const second = engine.addTask({ productId, title: "Build on it", description: "Second.", kind: "feature" });

    engine.setAfter(second, [first]);
    engine.setPoolPaused(false);
    let task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.state).toBe("queued");
    expect(task.statusLine).toBe("Waiting for “Lay the groundwork” to land");
    // Its journey starts with the wait, naming what it waits for.
    expect(task.journey).toEqual([expect.objectContaining({ kind: "wait", waitsOn: [{ id: first, title: "Lay the groundwork" }] })]);
    expect(task.journey![0]!.endedAt).toBeUndefined();
    expect(task.timeline.at(-1)).toMatchObject({ text: "It starts after “Lay the groundwork” lands", step: task.journey![0]!.id });

    expect(() => engine.setAfter(second, [second])).toThrow();
    expect(() => engine.setAfter(first, [second])).toThrow();
    expect(() => engine.setAfter(second, ["task-missing"])).toThrow();

    // A cancelled prerequisite no longer blocks, and the queue stops saying it waits for it.
    engine.setPoolPaused(true);
    engine.cancel(first);
    task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.statusLine).toBe("In the queue");
    engine.setPoolPaused(false);
    await waitFor(() => engine.getState().tasks.find((entry) => entry.id === second)!.journey?.[1], "the planner's journey step");
    task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.state).not.toBe("queued");
    expect(task.journey![0]).toMatchObject({ kind: "wait", end: "done", reason: "“Lay the groundwork” did not land: cancelled" });
    expect(task.journey![1]).toMatchObject({ kind: "agent", roleId: "planner" });
    expect(journeyProblems(task)).toEqual([]);

    });
  });

  it("ends the wait when it is removed", async () => {
    return cases.use("petrina-after-", async owner => {
      const engine = owner.open(join(owner.root, "data"), heldPlanning());
      engine.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue" });
      await engine.waitUntilReady();
    engine.setPoolPaused(true);
    const productId = engine.getState().products[0]!.id;
    const first = engine.addTask({ productId, title: "First again" });
    const second = engine.addTask({ productId, title: "Second again" });
    engine.setAfter(second, [first]);
    engine.setAfter(second, []);
    const task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task.journey).toEqual([expect.objectContaining({ kind: "wait", end: "done", reason: "no longer waits" })]);
    expect(task.statusLine).toBe("In the queue");

    });
  });

  it("on hold, ends the wait when the other task does", async () => {
    return cases.use("petrina-after-", async owner => {
      const engine = owner.open(join(owner.root, "data"), heldPlanning());
      engine.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue" });
      await engine.waitUntilReady();
    engine.setPoolPaused(true);
    const productId = engine.getState().products[0]!.id;
    const first = engine.addTask({ productId, title: "Groundwork" });
    const second = engine.addTask({ productId, title: "On top of it" });
    engine.setAfter(second, [first]);
    engine.setHeld(second, true);
    engine.cancel(first);
    const task = engine.getState().tasks.find((entry) => entry.id === second)!;
    expect(task).toMatchObject({ state: "queued", held: true });
    expect(task.journey).toEqual([expect.objectContaining({ kind: "wait", end: "done", reason: "“Groundwork” did not land: cancelled" })]);
    expect(task.statusLine).not.toMatch(/^Waiting for/);

    });
  });
});
