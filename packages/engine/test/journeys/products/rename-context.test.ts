import { productRenameAgents } from "../../fixtures/product-rename-agents.js";
import { describe, expect, it } from "bun:test";

import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../../engine.js";


import { makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

describe("product settings in the engine", () => {
it("gives the next agent the saved display name while keeping the working copy and branch", async () => {
    const root = tempDir("petrina-rename-agent-");
    const repo = await makeProduct(root);
    const fakes = productRenameAgents();
    const engine = new Engine(join(root, "data"), fakes);
    try {
      const id = await engine.addProduct(repo, "Original product");
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
    } finally { await engine.shutdown(); removeDir(root); }
  });
});
