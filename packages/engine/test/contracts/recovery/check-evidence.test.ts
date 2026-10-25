
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";

import { Engine } from "../../engine.js";
import { Coordination } from "../../../src/coordination.js";
import { EngineLifecycle, LifecycleStore } from "../../../src/lifecycle.js";

import { executionFor } from "@petrina/orchestrator";

import { heldMachineRecords, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

// Enter at check recording: no agents or unrelated planning/review workflow.

it.each(["drain", "stop", "restart", "shutdown"] as const)("cancels startup evidence recovery on %s without changing the saved failure", async (how) => {
  const root = tempDir("petrina-evidence-stop-");
  roots.push(root);
  const home = join(root, "data");
  const options = { usageCommands: { codex: null, grok: null }, agentCommand: () => undefined, terminals: () => [] };
  const seed = new Engine(home, options);
  seed.schedule = () => {};
  seed.s.products.push({ id: "product", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local" });
  const task = seed.task(seed.addTask({ productId: "product", title: "Waiting on failed checks" }))!;
  task.state = "needs-you";
  task.statusLine = "Checks still fail. Your call";
  const at = Date.parse("2026-10-21T17:54:07+03:00");
  executionFor(task).work.checks = { at, results: [{ name: "Tests", command: "test", ok: false, ms: 219_000, output: "Original failure", startedAt: at, endedAt: at + 219_000 }] };
  executionFor(task).work.checkReturns = 2;
  await seed.shutdown();
  // Even a completed read racing the stop must not update saved evidence.
  const held = heldMachineRecords("2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to Clamshell Sleep 74 secs");
  const cancelled = () => held.reads[0]?.aborted === true;
  const engine = new Engine(home, { ...options, machineRecords: held.source });
  engine.schedule = () => {};
  const restored = engine.task(task.id)!;
  let life: EngineLifecycle | undefined, store: LifecycleStore | undefined;
  let stops = 0;
  try {
    await waitFor(() => engine.backgroundWork.size === 1, "startup work other than evidence recovery to settle");
    const before = structuredClone(restored);
    expect(held.reads).toHaveLength(1);
    expect(engine.backgroundWork.size).toBe(1);
    if (how === "drain") {
      const draining = engine.drain(60_000);
      expect(cancelled()).toBe(true);
      expect(await draining).toBe(0);
    } else if (how === "shutdown") {
      await engine.shutdown();
      expect(cancelled()).toBe(true);
    } else {
      new Coordination(engine);
      store = new LifecycleStore(home);
      life = new EngineLifecycle(engine, store, async () => { stops++; });
      expect((await life.request(how, { requestId: "stop-during-evidence" })).outcome).toBe("pending");
      expect(cancelled()).toBe(true);
      await waitFor(() => stops === 1, "the stop to finish without waiting for the power log");
    }
    await waitFor(() => engine.backgroundWork.size === 0, "the cancelled startup read to settle");
    expect(restored).toEqual(before);
    expect(held.reads).toHaveLength(1);
  } finally {
    held.answer("");
    life?.close(); store?.close();
    await engine.shutdown();
    await Promise.allSettled([...engine.backgroundWork]);
  }
});
