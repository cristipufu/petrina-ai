import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextLine, type State } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { fakeEngineSettings } from "../../fixtures/fake-agent-sessions.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { Fakes, makeProduct, waitFor } from "../../support.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

it("names and enforces the check for unresolved review issues when shipping normally needs no approval", async () => {
  return engineCases.use("petrina-review-next-", async (caseOwner) => {
    const root = caseOwner.root;
    const fakes = new Fakes(join(root, "fake"));
    // One reviewer raises an Important finding in the only round; the voter holds until the test lets it go.
    fakes.scenario({ planner: "short", builder: "plain", reviewer: "important", verifier: "hold" });
    const product = await makeProduct(root, { origin: "none" });
    const engine = installSharedWorkflowFastPaths(caseOwner.open(join(root, "home"), fakeEngineSettings(fakes)));
    try {
      const productId = await caseOwner.run(engine, async () => {
        await engine.waitUntilReady();
        caseOwner.check();
        engine.stopRequested.signal.throwIfAborted();
        return installPreparedProduct(engine, privateCloneProduct(product));
      });
      engine.setProductDelivery(productId, "local", false);
      const taskId = engine.addTask({ productId, title: "Check the greeting" });
      const task = (state: State) => state.tasks.find((entry) => entry.id === taskId)!;
      await waitFor(() => fakes.marked("verifier-voting"), "the vote on an unresolved issue");
      const reviewing = engine.getState();
      expect(nextLine(reviewing, task(reviewing))).toBe("Next: your call, then Petrina commits to main");
      writeFileSync(join(fakes.dir, "release-vote"), "go");
      const waiting = await waitFor(() => {
        const state = engine.getState();
        return state.inbox.some((item) => item.kind === "delivery") ? state : undefined;
      }, "the mandatory check");
      expect(task(waiting).landed).toBeUndefined();
      expect(nextLine(waiting, task(waiting))).toBe("Next: Petrina commits to main");
      engine.approve(waiting.inbox.find((item) => item.kind === "delivery")!.id);
      const done = await waitFor(() => {
        const state = engine.getState();
        return ["done", "failed"].includes(task(state).state) ? state : undefined;
      }, "shipping after approval");
      expect(task(done).error).toBeUndefined();
      expect(task(done).state).toBe("done");
      expect((await gitOps.fileAt(product, "main", "greeting.txt"))?.trim()).toBe("Hello (with left-pad)");
    } finally {
      await caseOwner.stop(engine);
    }
  });
});
