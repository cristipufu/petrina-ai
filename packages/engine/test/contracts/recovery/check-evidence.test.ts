import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rejectionOf } from "@petrina/test-support/rejections";
import { Engine } from "../../engine.js";
import { Coordination } from "../../../src/coordination.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { executionFor } from "@petrina/orchestrator";
import { heldMachineRecords, waitFor } from "../../fixtures.js";

interface RecoveryOwner {
  root: string;
  engine: Engine;
  restored: NonNullable<ReturnType<Engine["task"]>>;
  held: ReturnType<typeof heldMachineRecords>;
  startup: Promise<unknown[]>;
  request(how: "stop" | "restart", stopped: () => void): Promise<Awaited<ReturnType<EngineLifecycle["request"]>>>;
}

const cases = engineCaseFixtures();
afterAll(() => cases.close());

async function prepareRecovery(lifetime: EngineCaseOwner, effects: { beforeHandoff?(owner: RecoveryOwner): Promise<void> } = {}): Promise<RecoveryOwner> {
  const root = lifetime.root;
  const home = join(root, "data");
  const options = { usageCommands: { codex: null, grok: null }, agentCommand: () => undefined, terminals: () => [] };
  const held = heldMachineRecords("2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to Clamshell Sleep 74 secs");
  let current: Engine | undefined, life: EngineLifecycle | undefined, store: LifecycleStore | undefined;
  lifetime.onStop(async () => {
    life?.close();
    const stopped = current ? lifetime.stop(current) : undefined;
    held.answer("");
    await stopped;
  });
  lifetime.afterBody(() => { store?.close(); });
    const seed = current = lifetime.open(home, options);
    seed.schedule = () => {};
    seed.s.products.push({ id: "product", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local" });
    const task = seed.task(seed.addTask({ productId: "product", title: "Waiting on failed checks" }))!;
    task.state = "needs-you";
    task.statusLine = "Checks still fail. Your call";
    const at = Date.parse("2026-10-21T17:54:07+03:00");
    executionFor(task).work.checks = { at, results: [{ name: "Tests", command: "test", ok: false, execution: completeCheckExecution(7), ms: 219_000, output: "Original failure", startedAt: at, endedAt: at + 219_000 }] };
    executionFor(task).work.checkReturns = 2;
    await lifetime.stop(seed);
    // Even a completed read racing the stop must not update saved evidence.
    const engine = current = lifetime.open(home, { ...options, machineRecords: held.source });
    engine.schedule = () => {};
    const restored = engine.task(task.id)!;
    // Observe completion; the Engine remains the owner of its constructor's background work.
    const startup = Promise.all([...engine.backgroundWork]);
    void startup.catch(() => {});
    const owner: RecoveryOwner = {
      root, engine, restored, held, startup,
      request(how, stopped) {
        return lifetime.prepare(async () => {
          new Coordination(engine);
          lifetime.check();
          store = new LifecycleStore(home);
          life = new EngineLifecycle(engine, store, async () => { stopped(); });
          return life.request(how, { requestId: "stop-during-evidence" });
        });
      },
    };
    await effects.beforeHandoff?.(owner);
    return owner;
}

function recoveryFixture<T>(lifetime: EngineCaseOwner, body: (owner: RecoveryOwner) => Promise<T>): Promise<T> {
  return lifetime.prepare(async () => { const owner = await prepareRecovery(lifetime); lifetime.check(); return body(owner); });
}

// Enter at check recording: no agents or unrelated planning/review workflow.
it.each(["drain", "stop", "restart", "shutdown"] as const)("cancels startup evidence recovery on %s without changing the saved failure", async how => {
  return cases.use("petrina-evidence-stop-", lifetime => recoveryFixture(lifetime, async owner => {
  const { engine, restored, held } = owner;
  const cancelled = () => held.reads[0]?.aborted === true;
  let stops = 0;
    await waitFor(() => engine.backgroundWork.size === 1, "startup work other than evidence recovery to settle", 30_000, { during: owner.startup });
    const before = structuredClone(restored);
    expect(held.reads).toHaveLength(1);
    expect(engine.backgroundWork.size).toBe(1);
    if (how === "drain") {
      const draining = lifetime.run(engine, () => engine.drain(60_000));
      expect(cancelled()).toBe(true);
      expect(await draining).toBe(0);
    } else if (how === "shutdown") {
      await lifetime.stop(engine);
      expect(cancelled()).toBe(true);
    } else {
      expect((await owner.request(how, () => { stops++; })).outcome).toBe("pending");
      expect(cancelled()).toBe(true);
      await waitFor(() => stops === 1, "the stop to finish without waiting for the power log");
    }
    await waitFor(() => engine.backgroundWork.size === 0, "the cancelled startup read to settle", 30_000, { during: owner.startup });
    expect(restored).toEqual(before);
    expect(held.reads).toHaveLength(1);
  }));
});

it("stops restored startup recovery when setup rejects before handing its owner back", async () => {
  const failure = new Error("Recovery setup failed before handoff");
  let observed: RecoveryOwner | undefined;
  await cases.use("petrina-evidence-stop-", async lifetime => {
    const outcome = await rejectionOf(prepareRecovery(lifetime, { beforeHandoff: async owner => {
      observed = owner;
      await waitFor(() => owner.held.reads.length === 1, "restored setup to start its evidence read", 30_000, { during: owner.startup });
      throw failure;
    } }));
    await lifetime.stop(observed!.engine);
  expect(outcome).toBe(failure);
  expect(observed!.engine.stopped).toBe(true);
  expect(observed!.held.reads).toHaveLength(1);
  expect(observed!.held.reads[0]!.aborted).toBe(true);
  expect(observed!.engine.backgroundWork.size).toBe(0);
  });
  expect(existsSync(observed!.root)).toBe(false);
});
