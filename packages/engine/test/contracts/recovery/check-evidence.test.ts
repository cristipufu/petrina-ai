import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { expect, it } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { rejectionOf } from "@petrina/test-support/rejections";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { Engine } from "../../engine.js";
import { Coordination } from "../../../src/coordination.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { executionFor } from "@petrina/orchestrator";
import { heldMachineRecords, removeDir, SLOW, tempDir, waitFor } from "../../fixtures.js";

interface RecoveryOwner {
  root: string;
  engine: Engine;
  restored: NonNullable<ReturnType<Engine["task"]>>;
  held: ReturnType<typeof heldMachineRecords>;
  operations: FixtureOperations;
  startup: Promise<unknown[]>;
  request(how: "stop" | "restart", stopped: () => void): Promise<Awaited<ReturnType<EngineLifecycle["request"]>>>;
  close(): Promise<void>;
}

async function recoveryFixture(effects: { beforeHandoff?(owner: RecoveryOwner): Promise<void> } = {}): Promise<RecoveryOwner> {
  const root = tempDir("petrina-evidence-stop-");
  const home = join(root, "data");
  const options = { usageCommands: { codex: null, grok: null }, agentCommand: () => undefined, terminals: () => [] };
  const held = heldMachineRecords("2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to Clamshell Sleep 74 secs");
  let current: Engine | undefined, life: EngineLifecycle | undefined, store: LifecycleStore | undefined;
  const operations = new FixtureOperations({
    async stop() {
      life?.close();
      const stopped = current?.shutdown();
      held.answer("");
      await stopped;
    },
    dispose() {
      store?.close();
      removeDir(root);
      try { lstatSync(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw new Error(`The recovery fixture could not remove ${root}`);
    },
    allowanceMs: CLEANUP_MS * SLOW, label: `Recovery fixture at ${root}`,
    arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  });
  return setupWithCleanup(async () => {
    const seed = current = new Engine(home, options);
    seed.schedule = () => {};
    seed.s.products.push({ id: "product", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local" });
    const task = seed.task(seed.addTask({ productId: "product", title: "Waiting on failed checks" }))!;
    task.state = "needs-you";
    task.statusLine = "Checks still fail. Your call";
    const at = Date.parse("2026-10-21T17:54:07+03:00");
    executionFor(task).work.checks = { at, results: [{ name: "Tests", command: "test", ok: false, execution: completeCheckExecution(7), ms: 219_000, output: "Original failure", startedAt: at, endedAt: at + 219_000 }] };
    executionFor(task).work.checkReturns = 2;
    await operations.run(() => seed.shutdown());
    // Even a completed read racing the stop must not update saved evidence.
    const engine = current = new Engine(home, { ...options, machineRecords: held.source });
    engine.schedule = () => {};
    const restored = engine.task(task.id)!;
    // Observe completion; the Engine remains the owner of its constructor's background work.
    const startup = Promise.all([...engine.backgroundWork]);
    void startup.catch(() => {});
    const owner: RecoveryOwner = {
      root, engine, restored, held, operations, startup,
      request(how, stopped) {
        return operations.run(() => {
          new Coordination(engine);
          store = new LifecycleStore(home);
          life = new EngineLifecycle(engine, store, async () => { stopped(); });
          return life.request(how, { requestId: "stop-during-evidence" });
        });
      },
      close: () => operations.close(),
    };
    await effects.beforeHandoff?.(owner);
    return owner;
  }, () => operations.close());
}

// Enter at check recording: no agents or unrelated planning/review workflow.
it.each(["drain", "stop", "restart", "shutdown"] as const)("cancels startup evidence recovery on %s without changing the saved failure", async how => {
  const owner = await recoveryFixture();
  const { engine, restored, held, operations } = owner;
  const cancelled = () => held.reads[0]?.aborted === true;
  let stops = 0;
  try {
    await waitFor(() => engine.backgroundWork.size === 1, "startup work other than evidence recovery to settle", 30_000, { during: owner.startup });
    const before = structuredClone(restored);
    expect(held.reads).toHaveLength(1);
    expect(engine.backgroundWork.size).toBe(1);
    if (how === "drain") {
      const draining = operations.run(() => engine.drain(60_000));
      expect(cancelled()).toBe(true);
      expect(await draining).toBe(0);
    } else if (how === "shutdown") {
      await operations.run(() => engine.shutdown());
      expect(cancelled()).toBe(true);
    } else {
      expect((await owner.request(how, () => { stops++; })).outcome).toBe("pending");
      expect(cancelled()).toBe(true);
      await waitFor(() => stops === 1, "the stop to finish without waiting for the power log");
    }
    await waitFor(() => engine.backgroundWork.size === 0, "the cancelled startup read to settle", 30_000, { during: owner.startup });
    expect(restored).toEqual(before);
    expect(held.reads).toHaveLength(1);
  } finally { await owner.close(); }
});

it("stops restored startup recovery when setup rejects before handing its owner back", async () => {
  const failure = new Error("Recovery setup failed before handoff");
  let observed: RecoveryOwner | undefined;
  const outcome = await rejectionOf(recoveryFixture({ beforeHandoff: async owner => {
    observed = owner;
    await waitFor(() => owner.held.reads.length === 1, "restored setup to start its evidence read", 30_000, { during: owner.startup });
    throw failure;
  } }));
  expect(outcome).toBe(failure);
  expect(observed!.engine.stopped).toBe(true);
  expect(observed!.held.reads).toHaveLength(1);
  expect(observed!.held.reads[0]!.aborted).toBe(true);
  expect(observed!.engine.backgroundWork.size).toBe(0);
  expect(existsSync(observed!.root)).toBe(false);
});
