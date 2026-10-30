import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { productRenameAgents } from "../../fixtures/product-rename-agents.js";
import { describe, expect, it } from "bun:test";

import { join } from "node:path";
import type { Task } from "@petrina/core";


import { makeProduct, waitFor } from "../../fixtures.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


describe("product settings in the engine", () => {
it("gives the next agent the saved display name while keeping the working copy and branch", async () => {
  return engineCases.use("petrina-rename-agent-", async caseOwner => {
    const root = caseOwner.root;
    const repo = await makeProduct(root);
    const fakes = productRenameAgents();
    const engine = caseOwner.open(join(root, "data"), fakes);
    try {
      const id = await caseOwner.run(engine, async () => {
        await engine.waitUntilReady(); caseOwner.check(); engine.stopRequested.signal.throwIfAborted();
        return installPreparedProduct(engine, { ...privateCloneProduct(repo), name: "Original product" });
      });
      const taskId = engine.addTask({ productId: id, title: "Use the product name" });
      const task = () => engine.getState().tasks.find((task) => task.id === taskId)! as Task;
      await waitFor(() => fakes.received("planner").length === 1, "planner to start");
      expect(task().worktree).toBeUndefined();
      expect(task().branch).toBeUndefined();
      // Its clone isn't linked to GitHub, so the product starts out keeping work on this machine.
      expect(task()).toMatchObject({ delivery: "local", approveDelivery: true });
      engine.updateProduct(id, { name: "Petrina AI", delivery: "pull-request", approveDelivery: false });
      fakes.release(fakes.received("planner")[0]!.session);
      await waitFor(() => fakes.received("researcher").length === 1, "next agent to receive the saved name");
      expect(fakes.prompts("researcher")[0]).toContain('"Petrina AI"');
      expect(fakes.prompts("researcher")[0]).not.toContain('"Original product"');
      expect(task().worktree).toBeDefined();
      expect(task().branch).toBeDefined();
      expect(task()).toMatchObject({ delivery: "local", approveDelivery: true });
    } finally { await caseOwner.stop(engine);  }

  });
});
});
