import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { prepareSharedDelivery } from "../../fixtures/shared-preparation.js";
import { makeProduct } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

it("refuses later delivery preparation and pool changes when its Engine stops during source observation", async () => {
  return cases.use("petrina-shared-preparation-", async owner => {
    const repo = await makeProduct(owner.root, { origin: "none" }); owner.check();
    const engine = owner.open(join(owner.root, "data"), { agentCommand: () => undefined, toolProbe: privateAgentToolProbe() });
    await engine.waitUntilReady(); owner.check();
    engine.setPoolPaused(true);
    const productId = installPreparedProduct(engine, { ...privateCloneProduct(repo), remote: undefined });
    const id = engine.addTask({ productId, title: "Prepare only while this generation is open", backlog: true });
    const task = engine.task(id)!, schedule = engine.schedule;
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    owner.onStop(() => release.resolve());
    const sources = engine["sources"], propose = sources.propose.bind(sources);
    const held = spyOn(sources, "propose").mockImplementation(async (...args) => {
      await propose(...args);
      reached.resolve();
      await release.promise;
    });
    const confirm = spyOn(sources, "confirm"), pool = spyOn(engine, "setPoolPaused");
    await owner.run(engine, async () => {
      const outcome = prepareSharedDelivery(engine, id).then(
        () => ({ ok: true as const }), error => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([reached.promise, outcome.then(() => { throw new Error("Preparation ended before its real source observation"); })]);
        expect(task.repository?.worktree).toBeUndefined();
        await engine.shutdown();
        const poolCalls = pool.mock.calls.length;
        release.resolve();
        const result = await outcome;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("A stopped Engine continued delivery preparation");
        expect(result.error).toBe(engine.stopRequested.signal.reason);
        expect(confirm.mock.calls).toEqual([]);
        expect(pool.mock.calls).toHaveLength(poolCalls);
        expect(task.repository?.worktree).toBeUndefined();
        expect(existsSync(join(engine.dataDir, "worktrees"))).toBe(false);
        expect(engine.schedule).toBe(schedule);
        expect(engine.stopped).toBe(true);
      } finally {
        release.resolve();
        await outcome;
        held.mockRestore(); confirm.mockRestore(); pool.mockRestore();
      }
    });
  });
});
