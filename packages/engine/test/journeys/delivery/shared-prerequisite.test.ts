import { describe, expect, it } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, type DeepMutable, type Product, type TaskRepository } from "@petrina/core";
import { scopesFor } from "@petrina/orchestrator";
import { WaitingForUsage } from "../../../src/usage.js";
import { Fakes, FAKE_AGENT, git, makeProduct, tempDir, waitFor } from "../../fixtures.js";


/** Only delivery, release and admission are exercised; planning and review have already settled. */
async function fixture() {
  const root = tempDir("petrina-wait-shared-"), lifetime = directDrivers(root);
  const controller = new AbortController(), gate = boundary();
  let closing: Promise<void> | undefined;
  const dispose = () => closing ??= Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    try { gate.release(); } catch (error) { errors.push(error); }
    try { controller.abort(); } catch (error) { errors.push(error); }
    try { await lifetime.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Shared-prerequisite fixture cleanup could not be confirmed");
  });
  return setupWithCleanup(() => lifetime.prepare(async () => {
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true, planner: "short", builder: "plain", reopen: "resume" });
  const engine = lifetime.open(join(root, "data"), { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], terminals: () => [] });
  engine.schedule = () => {};
  await engine.waitUntilReady();
  const products: DeepMutable<Product>[] = await completeAll(["Shop", "API"].map(async (name): Promise<DeepMutable<Product>> => ({
    id: name.toLowerCase(), name, repo: `local/${name.toLowerCase()}`, path: await makeProduct(join(root, name)),
    defaultBranch: "main", delivery: "local", tone: "blue", remoteRefused: "Local delivery only", checks: [],
  })));
  engine.s.products.push(...products);
  const first = products[0]!, second = products[1]!;
  const prerequisite = engine.addTask({ productId: first.id, title: "Land the prerequisite", backlog: true });
  const task = engine.task(engine.addTask({ productId: first.id, title: "Keep both products together", backlog: true }))!;
  task.repositories = await completeAll(products.map(async (product): Promise<DeepMutable<TaskRepository>> => {
    const worktree = join(root, `${product.id}-work`), branch = "task-change";
    await git(product.path!, "worktree", "add", "-qb", branch, worktree, "main");
    const baseSha = await git(worktree, "rev-parse", "HEAD");
    writeFileSync(join(worktree, "task-change.txt"), `${product.name}: accepted work\n`);
    await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "Improve the shared greeting");
    return {
      productId: product.id, delivery: "local", completedStages: ["build", "review"], preparation: "ready",
      branch, worktree, base: "main", baseSha,
      source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha },
    };
  }));
  delete task.repository;
  task.activeProductId = first.id;
  task.leadProductId = first.id;
  task.startedAt = 1; task.state = "waiting"; task.holdsSlot = false;
  task.plan = { rationale: "A shared change with settled review", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    { id: "approval", kind: "gate", title: "Approve delivery", roleId: "builder", profileIds: [], gate: "delivery" },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["sol-high"] },
  ] };
  task.stageIndex = 2;
  const hold = () => engine.setRuntimeWait(task.id, [prerequisite], "Both products need the prerequisite", "hold-shared");
  const effect = <T>(start: () => Promise<T>): Promise<T> => {
    let operation: Promise<T> | undefined;
    const tracked = lifetime.run(engine, () => {
      operation = start();
      // Waiting is this fixture's expected control result, not failed native cleanup. The caller
      // still receives the identical rejecting promise; all other failures remain owner failures.
      return operation.catch(error => { if (!(error instanceof WaitingForUsage)) throw error; });
    });
    return operation ?? tracked.then(() => { throw new Error("The shared native operation did not start"); });
  };
  return { root, engine, fakes, products, first, second, task, prerequisite, hold, shipping: engine["shipping"], signal: controller.signal,
    gate, dispose, run: <T>(work: () => Promise<T>) => lifetime.prepare(work),
    effect,
  };
  }), dispose);
}

function boundary() {
  let reached = false, release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached: () => { reached = true; }, release, released,
    wait: (during: Promise<unknown>) => waitFor(() => reached, "the admitted shared delivery boundary", undefined, { during }),
  };
}

describe.concurrent("runtime waits on a task across products", () => {






  it("settles interrupted admitted publishing while the refreshed companion can proceed", async () => {
    const f = await fixture();
    await setupWithCleanup(() => f.run(async () => {
    const { engine, products, task, hold, shipping, signal } = f;
    const updates = engine["updates"], upToDate = updates.upToDate.bind(updates);
    const refreshed: string[] = [];
    updates.upToDate = (...args) => { refreshed.push(args[0].work.productId); return upToDate(...args); };
    // These settled, unwaited empty batches need no new discovery conversation. Fail at its
    // admission instead of leaving a controlled Check finder waiting for an unrelated release.
    const ensure = engine["checks"].ensureChecks.bind(engine["checks"]);
    let discoveries = 0;
    engine["checks"].ensureChecks = async () => {
      discoveries++;
      throw new Error("An unwaited settled shared delivery unexpectedly started check discovery");
    };
    const settle = async () => { updates.upToDate = upToDate; engine["checks"].ensureChecks = ensure; };
    await setupWithCleanup(async () => {
      for (const scope of scopesFor(task)) {
        expect(await shipping["readyToShip"](scope, signal)).toBe("ready");
        expect(await shipping["prepare"](scope, task.plan!.stages[2]!, signal)).toBe("ready");
      }
      expect(refreshed).toEqual(products.map(product => product.id));
      const first = task.repositories![0]!;
      // A restart can find the durable write admission saved before its local move happened.
      first.shipping!.step = "update";
      const admitted = first.shipping!.prepared!.tested;
      hold(); engine.setRuntimeWait(task.id, [], "The companion can continue", "release-interrupted-publication");
      expect(await engine["driver"]["refreshAfterWait"](task, signal)).toBe(false);
      expect(task.runtimeWait?.refreshProducts).toEqual([first.productId]);
      expect(first.shipping!.prepared!.tested).toBe(admitted);
      expect(await f.effect(() => shipping.deliver(task, task.plan!.stages[2]!, signal))).toBe("stop");
      expect(task.state).toBe("done");
      expect(task.repositories!.every(work => !!work.landed)).toBe(true);
      expect(await git(products[0]!.path!, "rev-parse", "main")).toBe(admitted);
      expect(task.runtimeWait?.refreshPending).toBeUndefined();
      expect(task.rounds).toEqual({});
      expect(discoveries).toBe(0);
      expect(refreshed).toEqual([products[0]!.id, products[1]!.id, products[1]!.id, products[1]!.id]);
    }, settle);
    await settle();

    }), () => f.dispose());
    await f.dispose();
  });

  it("refreshes every product before the first unstarted step while preserving accepted work", async () => {
    const f = await fixture();
    await setupWithCleanup(() => f.run(async () => {
    const { engine, products, task, hold, signal } = f;

      task.stageIndex = 0;
      const originalHeads = await completeAll(task.repositories!.map(work => git(work.worktree!, "rev-parse", "HEAD")));
      hold();
      const latest = await completeAll(products.map(async (product) => {
        writeFileSync(join(product.path!, "incoming-fix.txt"), `${product.name}: required fix\n`);
        await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Land the required fix");
        return await git(product.path!, "rev-parse", "HEAD");
      }));
      engine.setRuntimeWait(task.id, [], "Both source updates are now ready", "clear-refresh");
      expect(await engine["driver"]["refreshAfterWait"](task, signal)).toBe(false);
      expect(task.runtimeWait?.refreshPending).toBeUndefined();
      expect(task.repositories!.map(work => work.baseSha)).toEqual(latest);
      for (const [index, { work }] of scopesFor(task).entries()) {
        const product = products[index]!;
        expect(await git(work.worktree!, "rev-parse", "HEAD")).not.toBe(originalHeads[index]!);
        expect(await git(work.worktree!, "rev-parse", "HEAD^")).toBe(latest[index]!);
        expect(readFileSync(join(work.worktree!, "incoming-fix.txt"), "utf8")).toBe(`${product.name}: required fix\n`);
        expect(readFileSync(join(work.worktree!, "task-change.txt"), "utf8")).toBe(`${product.name}: accepted work\n`);
      }
      expect(task.stageIndex).toBe(0);
      expect(task.rounds).toEqual({});


    }), () => f.dispose());
    await f.dispose();
  });

  it("holds all of its products while independent tasks on either product take the freed seats", async () => {
    const f = await fixture();
    await setupWithCleanup(() => f.run(async () => {
    const { engine, products, task, hold, fakes } = f;

      task.stageIndex = 0;
      task.holdsSlot = true;
      hold();
      const other = products.map(product => {
        const entry = engine.task(engine.addTask({ productId: product.id, title: `Independent ${product.name} work`, backlog: true }))!;
        entry.plan = structuredClone(task.plan!);
        entry.stageIndex = 0; entry.startedAt = 2; entry.state = "waiting"; entry.holdsSlot = false;
        entry.repository!.source = structuredClone(task.repositories!.find(work => work.productId === product.id)!.source!);
        return entry;
      });
      engine.setPoolLimit(2);
      await engine.waitUntilReady();
      engine["driver"].schedule();
      await waitFor(() => other.every(entry => fakes.received("builder").some(prompt => prompt.text.includes(entry.title))), "independent Builders on both products");
      expect(task.holdsSlot).toBe(false);
      expect(task.state).toBe("waiting");
      expect(task.runtimeWait?.after).toHaveLength(1);
      expect(other.every(entry => entry.holdsSlot && entry.agent?.roleId === "builder")).toBe(true);
      expect(fakes.received("builder").some(prompt => prompt.text.includes(task.title))).toBe(false);


    }), () => f.dispose());
    await f.dispose();
  });
});
