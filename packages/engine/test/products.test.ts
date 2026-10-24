import { describe, expect, it } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { serve } from "../src/server.js";
import { Store } from "../src/store.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

describe("product settings in the engine", () => {
  it("enforces names and atomic saves through the API, preserves repository identity, and keeps old task choices", async () => {
    const root = tempDir("petrina-products-");
    const initial = await makeProduct(root);
    const repo = join(root, "petrina-ai");
    renameSync(initial, repo);
    const secondRoot = join(root, "second");
    mkdirSync(secondRoot);
    const second = await makeProduct(secondRoot);
    const data = join(root, "data");
    let engine = new Engine(data);
    const server = serve(engine, { port: 0, token: "product-settings-test-key" });
    const act = async (name: string, ...args: unknown[]) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/action`, { method: "POST", headers: { authorization: "Bearer product-settings-test-key", "content-type": "application/json" }, body: JSON.stringify({ name, args }) });
      return await response.json() as { ok: boolean; result?: string; error?: string };
    };
    try {
      engine.setPoolPaused(true);
      const result = await act("addProduct", repo);
      expect(result.ok).toBe(true);
      const id = result.result!;
      expect(engine.getState().products[0]!.name).toBe("Petrina AI");
      const original = engine.getState().products[0]!;
      const other = await act("addProduct", second, "  Shop API  ");
      expect(other.ok).toBe(true);
      expect(engine.getState().products[1]!.name).toBe("Shop API");
      const task = engine.addTask({ productId: id, title: "Existing work" });
      const before = JSON.parse(JSON.stringify(engine.getState())) as State;
      for (const name of ["", "  ", "a".repeat(61), "one\ntwo", "shop api"]) {
        const response = await act("updateProduct", id, { name, delivery: "local", approveDelivery: false });
        expect(response.ok).toBe(false);
        expect(response.error).toBeDefined();
        expect(engine.getState().products).toEqual(before.products);
      }
      expect((await act("updateProduct", id, { name: "shop api", delivery: "local", approveDelivery: false })).error).toBe("Another product is already called Shop API.");
      expect((await act("updateProduct", id, { name: " Petrina HQ ", delivery: "local", approveDelivery: false })).ok).toBe(true);
      expect(engine.getState().products[0]).toEqual({ ...original, name: "Petrina HQ", delivery: "local", approveDelivery: false });
      expect(engine.getState().tasks.find((entry) => entry.id === task)).toEqual(before.tasks[0]);
      const next = engine.addTask({ productId: id, title: "New defaults" });
      expect(engine.getState().tasks.find((entry) => entry.id === next)).toMatchObject({ delivery: "local", approveDelivery: false });
      // Adding the same repository opens it, even if the proposed name is invalid or different.
      expect((await act("addProduct", repo, "")).result).toBe(id);
      expect(engine.getState().products[0]!.name).toBe("Petrina HQ");
      expect((await act("removeProduct", id)).error).toBe("2 tasks must finish or be cancelled before this product can be removed.");
      server.stop(true);
      await engine.shutdown();
      engine = new Engine(data);
      expect(engine.getState().products[0]!.name).toBe("Petrina HQ");
    } finally { server.stop(true); await engine.shutdown(); removeDir(root); }
  });

  it("refuses every unfinished state, then removes all finished and cancelled history and inbox entries durably", async () => {
    const root = tempDir("petrina-remove-");
    const repo = await makeProduct(root);
    const data = join(root, "data");
    let engine = new Engine(data);
    engine.setPoolPaused(true);
    const id = await engine.addProduct(repo);
    const first = engine.addTask({ productId: id, title: "Finished" });
    const seed = JSON.parse(JSON.stringify(engine.getState())) as State;
    await engine.shutdown();
    const write = (state: State) => {
      const store = new Store(join(data, "petrina.db"));
      store.save(state);
      store.close();
    };
    try {
      for (const state of ["queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open"] as const) {
        write({ ...seed, tasks: [{ ...seed.tasks[0]!, state }] });
        engine = new Engine(data);
        expect(() => engine.removeProduct(id)).toThrow("1 task must finish or be cancelled");
        await engine.shutdown();
      }
      write({ ...seed, tasks: [
        { ...seed.tasks[0]!, state: "done", column: "done" },
        { ...seed.tasks[0]!, id: "cancelled", state: "cancelled", column: "done" },
      ], inbox: [{ id: "old-question", taskId: first, title: "Old question", kind: "question", blocking: false, at: 0 }] });
      engine = new Engine(data);
      engine.removeProduct(id);
      expect(engine.getState().products).toEqual([]);
      expect(engine.getState().tasks).toEqual([]);
      expect(engine.getState().inbox).toEqual([]);
      await engine.shutdown();
      engine = new Engine(data);
      expect(engine.getState().tasks).toEqual([]);
      expect(engine.getState().products).toEqual([]);
    } finally { await engine.shutdown(); removeDir(root); }
  });

  it("gives the next agent the saved display name while keeping the working copy and branch", async () => {
    const root = tempDir("petrina-rename-agent-");
    const repo = await makeProduct(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "limits", controlled: true });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
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
      writeFileSync(join(fakes.dir, `release-${fakes.received("planner")[0]!.session}`), "go");
      await waitFor(() => fakes.received("researcher").length === 1, "next agent to receive the saved name");
      expect(fakes.prompts("researcher")[0]).toContain('"Petrina AI"');
      expect(fakes.prompts("researcher")[0]).not.toContain('"Original product"');
      expect(task().worktree).toBeDefined();
      expect(task().branch).toBeDefined();
      expect(task()).toMatchObject({ delivery: "local", approveDelivery: true });
    } finally { await engine.shutdown(); await Bun.sleep(100); removeDir(root); }
  });
});
