import { expect, it } from "bun:test";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
import { makeWorld, removeDir } from "../../support.js";

for (const approval of [false, true]) it(`starts settled delivery prerequisites at the saved ${approval ? "approval" : "publication"} boundary`, async () => {
  const world = await makeWorld(`prepared-choice-${approval}`);
  const engine = world.start({ agentCommand: () => { throw new Error("These settled prerequisites do not open an agent"); } });
  try {
    await engine.waitUntilReady();
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(world.clone);
    engine.setProductDelivery(productId, "pull-request", approval);
    const id = await queuePreparedDelivery(engine, { productId, title: "An already reviewed greeting" });
    const task = engine.task(id)!;
    expect(task.approveDelivery).toBe(approval);
    expect(task.plan!.stages[task.stageIndex]).toMatchObject(approval ? { kind: "gate", gate: "delivery" } : { kind: "do", roleId: "release-manager" });
    expect(task.repository?.source?.destination.mode).toBe("pull-request");
    expect(task.repository?.reviewedSha).toBeDefined();
    expect(task.repository?.checks).toBeUndefined();
    expect(world.github().calls.filter(call => call[1] === "create")).toEqual([]);
  } finally { await engine.shutdown(); removeDir(world.dir); }
});
