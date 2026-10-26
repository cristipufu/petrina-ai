import type { Engine } from "../../engine.js";
import { completeAll } from "@petrina/core";
import { prepareSharedDelivery } from "../../fixtures/shared-preparation.js";
import { afterAll, describe, expect, it } from "bun:test";
import { Coordination } from "../../../src/coordination.js";
import { finish, itemOf, taskOf, until, waitFor } from "../../support.js";

import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());
async function pollPullRequests(engine: Engine, taskId: string) { const monitor = engine["shipping"].monitor; await waitFor(() => !engine.drivers.has(taskId) && !monitor["following"].has(taskId), "the task's pull requests to be free to read"); await monitor.pollPullRequests(); }
async function coordinatorDelivery(engine: ConstructorParameters<typeof Coordination>[0], taskId: string) { const coordination = new Coordination(engine); const { landing, deliveryConfirmed } = (await coordination.call("task.inspect", { taskId })).task as { landing: string; deliveryConfirmed: boolean }; const [delivered, landed] = await completeAll(["delivered", "landed"].map(async (condition): Promise<string> => (await coordination.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome)); return { landing, deliveryConfirmed, delivered, landed }; }

describe.concurrent("one task across products", () => {


  for (const closed of [false, true]) it(`keeps dependents blocked with one merged PR and one ${closed ? "closed" : "open"} PR`, async () => {
    await fixtures.world(`landing-${closed}`, async ({ shop, api, engine: withEngine }) => {

    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "A shared change" });
      await prepareSharedDelivery(engine, id, {});
      engine.schedule();
      const completed = taskOf(await finish(engine, id), id);
      expect(completed.error).toBeUndefined();
      expect(completed.state).toBe("pr-open");
      const dependent = engine.addTask({ productId: first, title: "Follow-up", after: [id] });
      // Merge the product the task shows, so its own outcome cannot speak for the companion.
      const shown = engine.task(id)!.activeProductId === first ? 0 : 1;
      const [merging, other] = shown === 0 ? [shop, api] : [api, shop];
      if (!closed) merging.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
      if (closed) api.setGitHub((state) => { state.prs[0]!.state = "CLOSED"; });
      // Use the normal poll through its timer, without waiting a minute.
      await pollPullRequests(engine, id);
      const task = taskOf(engine.getState(), id);
      expect(task.state).toBe(closed ? "needs-you" : "pr-open");
      expect(engine.blockers(engine.task(dependent)!)).toHaveLength(1);
      if (closed) expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "closed"]);
      else expect(task.repositories!.map((work) => work.pr!.state)).toEqual(shown === 0 ? ["merged", "open"] : ["open", "merged"]);
      expect(await coordinatorDelivery(engine, id)).toEqual(closed ? { landing: "closed", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" } : { landing: "awaiting-merge", deliveryConfirmed: true, delivered: "completed", landed: "timed-out" });
      if (closed) {
        const decision = itemOf(engine.getState(), id, "shipping")!;
        expect(decision.title).toContain("API");
        engine.markDone(decision.id);
        expect(engine.task(id)!.state).toBe("pr-open");
        expect(engine.blockers(engine.task(dependent)!)).toHaveLength(1);
        shop.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
        await pollPullRequests(engine, id);
        expect(engine.task(id)!.state).toBe("done");
      } else {
        other.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
        await pollPullRequests(engine, id);
        expect(engine.task(id)!.state).toBe("done");
      }
      // Accepting the closed companion releases the dependent work too, without proving it landed.
      expect(engine.blockers(engine.task(dependent)!)).toHaveLength(0);
      const final = closed ? { landing: "closed", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" } : { landing: "landed", deliveryConfirmed: true, delivered: "completed", landed: "completed" };
      expect(await coordinatorDelivery(engine, id)).toEqual(final);
      const coordination = new Coordination(engine);
      for (const productId of [first, second]) expect((await coordination.call("task.history", { productId, taskId: id })).items).toEqual([expect.objectContaining({ landing: final.landing, deliveryConfirmed: final.deliveryConfirmed })]);

    });
    });
  });

  it("retries companion linking alone after both publications are confirmed", async () => {
    await fixtures.world("links", async ({ shop, api, engine: withEngine }) => {
    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      api.setGitHub((state) => { state.fail = { "pr edit": 1 }; });
      const id = engine.addTask({ backlog: true, productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Finish links" });
      await prepareSharedDelivery(engine, id, {});
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
