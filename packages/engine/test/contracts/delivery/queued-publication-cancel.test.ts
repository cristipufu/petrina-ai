import { describe, expect, it } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { Aborted } from "../../../src/kernel.js";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
import { makeWorld, removeDir, remoteRef, taskOf, until } from "../../support.js";
import { rejectionOf } from "@petrina/test-support/rejections";

describe.concurrent("A delivery interrupted at any step never goes out twice", () => {
  it("never starts a publishing step that was waiting in line when the task was cancelled", async () => {
    const w = await makeWorld("cancel-queued");
    const engine = w.start({ agentCommand: () => { throw new Error("Prepared pull requests need no provider"); } });
    const schedule = engine.schedule.bind(engine);
    engine.schedule = () => {};
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let queued: Promise<unknown> | undefined, occupying: Promise<unknown> | undefined, b: string | undefined;
    try {
      await engine.waitUntilReady(); engine.setPoolPaused(false);
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const a = await queuePreparedDelivery(engine, { productId, title: "Task A", description: "A greeting file. [quick]" });
      b = await queuePreparedDelivery(engine, { productId, title: "Task B", description: "A greeting file. [quick]" });
      const task = engine.task(b)!, scope = executionFor(task), shipping = engine["shipping"];
      const stage = task.plan!.stages[task.stageIndex]!;
      expect(await shipping["readyToShip"](scope, controller.signal)).toBe("ready");
      expect(await shipping["prepare"](scope, stage, controller.signal)).toBe("ready");
      const remote = await engine["connections"].requireConnection(scope, controller.signal);
      // A real in-flight repository operation owns the same line as native publication.
      occupying = engine["connections"].serial(productId, async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      task.state = "running";
      engine.drivers.set(b, controller);
      let started = 0;
      const publishing = shipping["publishStep"](scope, controller.signal, "push", "Publishing: pushing the branch to GitHub", async () => {
        started++;
        return gitOps.push(w.clone, remote, [{ sha: scope.work.shipping!.prepared!.tested, ref: `refs/heads/${scope.work.branch!}` }]);
      });
      queued = rejectionOf(publishing);
      expect(task.state).toBe("running");
      expect(started).toBe(0);
      engine.cancel(b);
      expect(controller.signal.aborted).toBe(true);
      release.resolve(); await occupying;
      expect(await queued).toBeInstanceOf(Aborted);
      expect(started).toBe(0);
      engine.drivers.delete(b);
      // Nearby positive: another task still publishes through its actual driver and GitHub peer.
      engine.schedule = schedule; engine.schedule();
      const state = await until(engine, current => taskOf(current, a).state === "pr-open");
      const cancelled = taskOf(engine.getState(), b);
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.pr).toBeUndefined();
      expect(await remoteRef(w.remote, `refs/heads/${cancelled.branch}`)).toBeUndefined();
      expect(w.github().prs.map(pr => pr.headRefName)).toEqual([taskOf(state, a).branch!]);
    } finally {
      release.resolve(); await occupying; await queued;
      if (b) engine.drivers.delete(b);
      await engine.shutdown(); removeDir(w.dir);
    }
  });
});
