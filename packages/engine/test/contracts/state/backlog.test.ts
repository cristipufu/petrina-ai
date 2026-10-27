import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { heldPlanning } from "../../fixtures/state-admission.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { queueOf } from "@petrina/core";
import { dispatch } from "../../../src/server.js";
import { waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("keeps reviewed requests out of agent work through a restart and queues them exactly once", async () => {
  return cases.use("petrina-backlog-", async owner => {
  const root = owner.root;
  const data = join(root, "data");
  const options = heldPlanning();
  let engine = owner.open(data, options);
  try {
    const productId = "product"; engine.s.products.push({ id: productId, name: "Product", repo: "local/product", tone: "blue" });
    const id = engine.addTask({ productId, title: "Draft request", description: "Check scope", backlog: true });
    engine.setPoolPaused(false);
    engine.schedule();
    expect(engine.task(id)!.state).toBe("backlog");
    expect(engine.task(id)!.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    await owner.stop(engine);
    engine = owner.open(data, options);
    expect(engine.task(id)!.state).toBe("backlog");
    expect(engine.task(id)!.startedAt).toBeUndefined();
    await dispatch(engine, { name: "updateBacklog", args: [id, { title: "Reviewed request", description: "Clear requirements" }] });
    engine.setPoolPaused(true);
    await dispatch(engine, { name: "queueTask", args: [id] });
    await dispatch(engine, { name: "queueTask", args: [id] });
    expect(queueOf(engine.activeState().tasks).map((task) => task.id)).toEqual([id]);
    engine.moveToBacklog(id);
    expect(engine.task(id)!.state).toBe("backlog");
    engine.queueTask(id);
    engine.setPoolPaused(false);
    await waitFor(() => engine.task(id)!.startedAt !== undefined, "the explicitly queued task to start");
    expect(engine.task(id)!.title).toBe("Reviewed request");
    engine.moveToBacklog(id);
    expect(engine.task(id)!.state).not.toBe("backlog");
    expect(() => engine.updateBacklog(id, { title: "Too late", description: "" })).toThrow("Only backlog requests");
  } finally { await owner.stop(engine); }

  });
});
