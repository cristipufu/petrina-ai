import { installSharedWorkflowFastPaths, prepareSharedDelivery } from "../../fixtures/shared-preparation.js";
import { afterAll, describe, expect, it } from "bun:test";
import { finish, itemOf, taskOf, until } from "../../support.js";

import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());
describe.concurrent("one task across products", () => {


  it("retries companion linking alone after both publications are confirmed", async () => {
    await fixtures.world("links", async ({ shop, api, engine: withEngine }) => {
    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, fastCheckCapture: true, fastCleanup: true });

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      api.setGitHub((state) => { state.fail = { "pr edit": 1 }; });
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Finish links" });
      await prepareSharedDelivery(engine, id, { checks: "none" });
      engine.schedule();
      const waiting = await until(engine, (state) => taskOf(state, id).statusLine === "Deliveries saved. Finish links");
      expect(taskOf(waiting, id).repositories!.every((work) => work.pr)).toBe(true);
      engine.retry(itemOf(waiting, id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      for (const world of [shop, api]) expect(world.github().calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);

    });
    });
  });
});
