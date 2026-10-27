import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { commandInputText, type State } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";

import { serve } from "../../../src/server.js";
import { Store } from "@petrina/storage/store";
import { makeProduct } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe("product settings in the engine", () => {
  it("enforces names and atomic saves through the API, preserves repository identity, and keeps old task choices", async () => {
  return cases.use("petrina-products-", async owner => {
    const root = owner.root;
    const initial = await makeProduct(root);
    const repo = join(root, "petrina-ai");
    renameSync(initial, repo);
    const secondRoot = join(root, "second");
    mkdirSync(secondRoot);
    const second = await makeProduct(secondRoot);
    const data = join(root, "data");
    let engine = owner.open(data, {});
    owner.check();
    const server = serve(engine, { port: 0, token: "product-settings-test-key" });
    owner.onStop(() => server.stop(true));
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
      await owner.stop(engine);
      engine = owner.open(data, {});
      expect(engine.getState().products[0]!.name).toBe("Petrina HQ");
    } finally { server.stop(true); await owner.stop(engine); }

  });
});

  it("refuses every unfinished state, then removes all finished and cancelled history and inbox entries durably", async () => {
  return cases.use("petrina-remove-", async owner => {
    const root = owner.root;
    const data = join(root, "data");
    let engine = owner.open(data, {});
    engine.setPoolPaused(true);
    const id = "product"; engine.s.products.push({ id, name: "Product", repo: "local/product", tone: "blue" });
    const first = engine.addTask({ productId: id, title: "Finished" });
    const seed = JSON.parse(JSON.stringify(engine.getState())) as State;
    await owner.stop(engine);
    const write = (state: State) => {
      owner.check();
      const store = new Store(join(data, "petrina.db"));
      let closed = false;
      const closeStore = () => { if (!closed) { store.close(); closed = true; } };
      owner.afterBody(closeStore);
      try { store.save(state); } finally { closeStore(); }
    };
    try {
      for (const state of ["queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open"] as const) {
        write({ ...seed, tasks: [{ ...seed.tasks[0]!, state }] });
        engine = owner.open(data, {});
        expect(() => engine.removeProduct(id)).toThrow("1 task must finish or be cancelled");
        await owner.stop(engine);
      }
      write({ ...seed, tasks: [
        { ...seed.tasks[0]!, state: "done", column: "done" },
        { ...seed.tasks[0]!, id: "cancelled", state: "cancelled", column: "done" },
      ], inbox: [{ id: "old-question", taskId: first, title: "Old question", kind: "question", blocking: false, at: 0 }] });
      engine = owner.open(data, {});
      engine.removeProduct(id);
      expect(engine.getState().products).toEqual([]);
      expect(engine.getState().tasks).toEqual([]);
      expect(engine.getState().inbox).toEqual([]);
      await owner.stop(engine);
      engine = owner.open(data, {});
      expect(engine.getState().tasks).toEqual([]);
      expect(engine.getState().products).toEqual([]);
    } finally { await owner.stop(engine); }

  });
});


});

it("saves literal check input through the real API and restart without executing it", async () => {
  return cases.use("petrina-records-", async owner => {
  const root = owner.root, data = join(root, "data");
  let server: ReturnType<typeof serve> | undefined;
  owner.onStop(async () => { await server?.stop(true); server = undefined; });
    const options = { agentCommand: () => undefined, terminals: () => [] };
    const engine = owner.open(data, options); await engine.waitUntilReady(); engine.setPoolPaused(true);
    engine.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue" });
    const taskId = engine.addTask({ productId: "product", title: "Preserve the saved record", backlog: true });
    const work = executionFor(engine.task(taskId)!).work;
    // Deliberate legacy data: the saved current flag is not setup/native pass evidence.
    work.checks = { at: 1, current: true, results: [] }; work.checkReturns = 2;
    const beforeProduct = structuredClone(engine.s.products[0]), beforeWork = structuredClone(work);
    owner.check();
    server = serve(engine, { port: 0, token: "literal-command-input-test-key" });
    const rejected = await fetch(`http://127.0.0.1:${server.port}/api/action`, { method: "POST", headers: {
      authorization: "Bearer literal-command-input-test-key", "content-type": "application/json",
    }, body: JSON.stringify({ name: "setProductChecks", args: ["product", []] }) });
    expect(await rejected.json()).toMatchObject({ ok: false, error: expect.stringContaining("Give at least one check") });
    expect(engine.s.products[0]).toEqual(beforeProduct);
    expect(work).toEqual(beforeWork);
    const marker = join(root, "must-not-run.txt");
    const argv = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not run')`,
      "", `both 'single' and "double"`, String.raw`C:\Users\O'Neil\Program Files\tool.exe`, "line one\nline two", String.raw`literal\n`];
    const name = "Owner's: checks\nsecond line";
    const response = await fetch(`http://127.0.0.1:${server.port}/api/action`, { method: "POST", headers: {
      authorization: "Bearer literal-command-input-test-key", "content-type": "application/json",
    }, body: JSON.stringify({ name: "setProductChecks", args: ["product", [{ name, command: commandInputText(argv) }]] }) });
    expect(await response.json()).toEqual({ ok: true, result: null });
    expect(engine.getState().products[0]!.checks).toEqual([{ name, argv }]);
    expect(engine.getState().products[0]!.checksBy).toBe("coordinator");
    expect(engine.getState().products[0]!.checkSetup).toBeUndefined();
    expect(engine.getState().tasks.map(task => task.id)).toEqual([taskId]);
    expect(engine.task(taskId)!.journey ?? []).toEqual([]);
    expect(work.checks!.current).toBe(false); expect(work.checkReturns).toBe(2);
    expect(existsSync(marker)).toBe(false);
    await server.stop(true); server = undefined;
    await owner.stop(engine);
    const reopened = owner.open(data, options); await reopened.waitUntilReady(); reopened.setPoolPaused(true);
    expect(reopened.getState().products[0]!.checks).toEqual([{ name, argv }]);
    expect(reopened.getState().products[0]!.checkSetup).toBeUndefined();
    expect(existsSync(marker)).toBe(false);


  });
});
