import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeWaitView, type DeepMutable, type Product, type TaskRepository } from "@petrina/core";
import { Engine } from "../../engine.js";
import { scopesFor } from "@petrina/orchestrator";
import { WaitingForUsage } from "../../../src/usage.js";
import { Fakes, FAKE_AGENT, git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Only delivery, release and admission are exercised; planning and review have already settled. */
async function fixture() {
  const root = tempDir("petrina-wait-shared-"); roots.push(root);
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ controlled: true, planner: "short", builder: "plain", reopen: "resume" });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], terminals: () => [] });
  engine.schedule = () => {};
  const products: DeepMutable<Product>[] = await Promise.all(["Shop", "API"].map(async (name): Promise<DeepMutable<Product>> => ({
    id: name.toLowerCase(), name, repo: `local/${name.toLowerCase()}`, path: await makeProduct(join(root, name)),
    defaultBranch: "main", delivery: "local", tone: "blue", remoteRefused: "Local delivery only", checks: [],
  })));
  engine.s.products.push(...products);
  const first = products[0]!, second = products[1]!;
  const prerequisite = engine.addTask({ productId: first.id, title: "Land the prerequisite", backlog: true });
  const task = engine.task(engine.addTask({ productId: first.id, title: "Keep both products together", backlog: true }))!;
  task.repositories = await Promise.all(products.map(async (product): Promise<DeepMutable<TaskRepository>> => {
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
  return { root, engine, fakes, products, first, second, task, prerequisite, hold, shipping: engine["shipping"], signal: new AbortController().signal };
}

function boundary() {
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { ready, reached, release, released };
}

describe.concurrent("runtime waits on a task across products", () => {
  it("finishes admitted preparation, then neither prepares the next product nor publishes either product", async () => {
    const { engine, products, first, task, hold, shipping, signal } = await fixture();
    const gate = boundary(), ready = shipping["readyToShip"].bind(shipping), prepare = shipping["prepare"].bind(shipping);
    const preparing: string[] = [], publishing: string[] = [];
    shipping["readyToShip"] = async (...args) => { preparing.push(args[0].work.productId); return ready(...args); };
    shipping["prepare"] = async (...args) => {
      const result = await prepare(...args);
      if (args[0].work.productId === first.id) { gate.reached(); await gate.released; }
      return result;
    };
    const publish = shipping["deliverOne"].bind(shipping);
    shipping["deliverOne"] = (...args) => { publishing.push(args[0].work.productId); return publish(...args); };
    let delivery: Promise<unknown> | undefined;
    try {
      const bases = task.repositories!.map(work => work.baseSha!);
      delivery = rejectionOf(shipping.deliver(task, task.plan!.stages[2]!, signal));
      await gate.ready;
      expect(task.repositories![0]!.shipping?.prepared).toBeDefined();
      hold(); gate.release();
      expect(await delivery).toBeInstanceOf(WaitingForUsage);
      expect(preparing).toEqual([first.id]);
      expect(publishing).toEqual([]);
      expect(task.repositories![1]!.shipping).toBeUndefined();
      expect(await Promise.all(products.map(product => git(product.path!, "rev-parse", "main")))).toEqual(bases);
      expect(task.repositories!.every(work => !work.landed)).toBe(true);
      expect(task.rounds).toEqual({});
    } finally { gate.release(); await delivery; await engine.shutdown(); }
  });

  it("finishes the first product's admitted publication and holds the prepared companion until release", async () => {
    const { engine, products, first, second, task, hold, shipping, signal } = await fixture();
    const gate = boundary(), verify = shipping.verifier.verifyLocal.bind(shipping.verifier);
    const publish = shipping["deliverOne"].bind(shipping), publishing: string[] = [];
    shipping["deliverOne"] = (...args) => { publishing.push(args[0].work.productId); return publish(...args); };
    shipping.verifier.verifyLocal = async (...args) => {
      if (args[0] === first.path) { gate.reached(); await gate.released; }
      return verify(...args);
    };
    let delivery: Promise<unknown> | undefined;
    try {
      const secondBase = task.repositories![1]!.baseSha;
      delivery = rejectionOf(shipping.deliver(task, task.plan!.stages[2]!, signal));
      await gate.ready;
      expect(task.repositories!.every(work => !!work.shipping?.prepared)).toBe(true);
      expect(task.repositories![0]!.shipping?.step).toBe("update");
      hold(); gate.release();
      expect(await delivery).toBeInstanceOf(WaitingForUsage);
      expect(publishing).toEqual([first.id]);
      expect(task.repositories![0]!.landed).toBeDefined();
      expect(task.repositories![1]!.landed).toBeUndefined();
      expect(task.repositories![1]!.shipping?.step).toBeUndefined();
      expect(await git(second.path!, "rev-parse", "main")).toBe(secondBase!);
      expect(runtimeWaitView(task, id => engine.task(id))?.held).toBe(true);
      engine.setRuntimeWait(task.id, [], "The remaining product can now publish", "clear-shared");
      expect(await shipping.deliver(task, task.plan!.stages[2]!, signal)).toBe("continue");
      expect(await engine["driver"]["refreshAfterWait"](task, signal)).toBe(false);
      expect(await shipping.deliver(task, task.plan!.stages[2]!, signal)).toBe("stop");
      expect(publishing).toEqual([first.id, second.id]);
      expect(task.repositories!.every(work => !!work.landed)).toBe(true);
      expect(task.state).toBe("done");
      for (const product of products) expect(readFileSync(join(product.path!, "task-change.txt"), "utf8")).toBe(`${product.name}: accepted work\n`);
    } finally { gate.release(); await delivery; await engine.shutdown(); }
  });

  it("returns to source updates before preparing a companion when the wait ended during the first preparation", async () => {
    const { engine, products, first, task, hold, shipping, signal } = await fixture();
    const gate = boundary(), prepare = shipping["prepare"].bind(shipping);
    const prepared: string[] = [];
    shipping["prepare"] = async (...args) => {
      prepared.push(args[0].work.productId);
      const result = await prepare(...args);
      if (prepared.length === 1) { gate.reached(); await gate.released; }
      return result;
    };
    const delivery = shipping.deliver(task, task.plan!.stages[2]!, signal).catch(error => error);
    try {
      await gate.ready; hold();
      for (const product of products) {
        writeFileSync(join(product.path!, "required-fix.txt"), `${product.name}: required fix\n`);
        await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Land the prerequisite");
      }
      engine.setRuntimeWait(task.id, [], "The required sources are ready", "release-during-preparation");
      gate.release();
      expect(await delivery).toBe("continue");
      expect(prepared).toEqual([first.id]);
      expect(task.repositories!.every(work => !work.landed)).toBe(true);
      expect(task.runtimeWait?.refreshPending).toBe(true);
      expect(await engine["driver"]["refreshAfterWait"](task, signal)).toBe(false);
      expect(await shipping.deliver(task, task.plan!.stages[2]!, signal)).toBe("stop");
      expect(task.state).toBe("done");
      for (const product of products) expect(readFileSync(join(product.path!, "required-fix.txt"), "utf8")).toBe(`${product.name}: required fix\n`);
      expect(task.runtimeWait?.refreshPending).toBeUndefined();
      expect(task.rounds).toEqual({});
    } finally { gate.release(); await delivery; await engine.shutdown(); }
  });

  it("settles interrupted admitted publishing while the refreshed companion can proceed", async () => {
    const { engine, products, task, hold, shipping, signal } = await fixture();
    const updates = engine["updates"], upToDate = updates.upToDate.bind(updates);
    const refreshed: string[] = [];
    updates.upToDate = (...args) => { refreshed.push(args[0].work.productId); return upToDate(...args); };
    // These settled, unwaited empty batches need no new discovery conversation. Fail at its
    // admission instead of leaving a controlled Check finder waiting for an unrelated release.
    let discoveries = 0;
    engine["checks"].ensureChecks = async () => {
      discoveries++;
      throw new Error("An unwaited settled shared delivery unexpectedly started check discovery");
    };
    try {
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
      expect(await shipping.deliver(task, task.plan!.stages[2]!, signal)).toBe("stop");
      expect(task.state).toBe("done");
      expect(task.repositories!.every(work => !!work.landed)).toBe(true);
      expect(await git(products[0]!.path!, "rev-parse", "main")).toBe(admitted);
      expect(task.runtimeWait?.refreshPending).toBeUndefined();
      expect(task.rounds).toEqual({});
      expect(discoveries).toBe(0);
      expect(refreshed).toEqual([products[0]!.id, products[1]!.id, products[1]!.id, products[1]!.id]);
    } finally { await engine.shutdown(); }
  });

  it("refreshes every product before the first unstarted step while preserving accepted work", async () => {
    const { engine, products, task, hold, signal } = await fixture();
    try {
      task.stageIndex = 0;
      const originalHeads = await Promise.all(task.repositories!.map(work => git(work.worktree!, "rev-parse", "HEAD")));
      hold();
      const latest = await Promise.all(products.map(async (product) => {
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
    } finally { await engine.shutdown(); }
  });

  it("holds all of its products while independent tasks on either product take the freed seats", async () => {
    const { engine, products, task, hold, fakes } = await fixture();
    try {
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
    } finally { await engine.shutdown(); }
  });
});
