import { afterAll, expect, it } from "bun:test";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
const fixtures = nativeWorldFixtures();
afterAll(() => fixtures.close());

for (const approval of [false, true]) it(`starts settled delivery prerequisites at the saved ${approval ? "approval" : "publication"} boundary`, async () => {
  return fixtures.world(`prepared-choice-${approval}`, ({ world, engine: withEngine }) => withEngine(async engine => {
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
  }, { agentCommand: () => { throw new Error("These settled prerequisites do not open an agent"); } }));
});
