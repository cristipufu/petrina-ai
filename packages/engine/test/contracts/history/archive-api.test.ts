import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewStats, withoutProduct, type State } from "@petrina/core";
import { dispatch, serve } from "../../../src/server.js";
import { Engine } from "../../engine.js";

import { historyTask as task, historyState as state, reviewedHistoryTask as reviewedTask } from "../../../../core/test/fixtures/history-records.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());

function recordWorld(owner: EngineCaseOwner) {
 const dir = owner.root, data = join(dir, "data");
 return { dir, data, start: (options = {}) => owner.open(data, { admissionsClosed: true, ...options }) };
}
function recordProduct(engine: Engine) {
 const id = "product"; if (!engine.s.products.some(product => product.id === id)) engine.s.products.push({ id, name: "Product", repo: "local/product", tone: "blue" });
 engine.tracking.log.recordProduct({ id, name: "Product", repo: "local/product", addedAt: 1 });
 return id;
}

describe.concurrent("Finished work is indexed outside the live snapshot", () => {
it("keeps archived task details and dependencies available without sending bodies to the window", async () => {
  return cases.use("petrina-history-", async owner => {
    const world = recordWorld(owner);
    let engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = recordProduct(engine);
      const ids = Array.from({ length: 5 }, (_, index) => engine.addTask({ productId, title: `Review later ${index}`, clientId: `request-${index}` }));
      for (const id of ids) engine.cancel(id);
      const window = engine.windowState();
      expect(window.tasks).toEqual([]);
      expect(window.history?.total).toBe(5);
      expect(engine.activeState().tasks).toEqual([]);
      expect(engine.getState().tasks).toHaveLength(5);
      expect(engine.getState().history).toBeUndefined();
      expect(engine.historyPage({ productId, limit: 2 }).items).toHaveLength(2);
      const history = await dispatch(engine, { name: "historyPage", args: [{ productId, limit: 2, includeUsage: true }] }) as import("@petrina/core").HistoryPage;
      expect(history.items.map(item => item.usage?.empty)).toEqual(["nothing", "nothing"]);
      expect(engine.historyPage({ productId, limit: 2 }).items.every(item => !("usage" in item))).toBe(true);
      expect(engine.taskDetails(ids[0]!)?.title).toBe("Review later 0");
      expect(engine.addTask({ productId, title: "Lost reply", clientId: "request-0" })).toBe(ids[0]!);
      const following = engine.addTask({ productId, title: "After the finished work" });
      engine.setAfter(following, [ids[0]!]);
      expect(engine.blockers(engine.task(following)!)).toEqual([]);
      const dependencies = engine.windowState().history!.dependencies!;
      expect(dependencies.find((entry) => entry.id === ids[0])?.title).toBe("Review later 0");
      expect(engine.windowState().history!.dependencies).toBe(dependencies);
      const archived = engine.task(ids[0]!)!;
      archived.statusLine = "Updated archived details"; engine.commitNow(archived);
      expect(engine.windowState().history!.dependencies).not.toBe(dependencies);
      expect(engine.windowState().history!.dependencies!.find(entry => entry.id === archived.id)!.statusLine).toBe("Updated archived details");
      owner.check();
      const server = serve(engine, { port: 0, token: "history-fixture" });
      owner.onStop(() => server.stop(true));
      try {
        const raw = await (await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { authorization: "Bearer history-fixture" } })).json() as State;
        expect(raw.tasks.map((entry) => entry.id)).toEqual([following]);
        expect(raw.history?.total).toBe(5);
        expect(raw.history?.dependencies?.some((entry) => "session" in entry)).toBe(false);
      } finally { server.stop(true); }
      await owner.stop(engine);
      expect(() => engine.getState()).not.toThrow();
      expect(() => engine.windowState()).not.toThrow();
      expect(() => engine.historyPage({})).toThrow("The engine has stopped");
      expect(engine.getState().tasks.some((entry) => entry.id === following)).toBe(true);
      engine = world.start();
      expect(engine.windowState().tasks.map((entry) => entry.id)).toEqual([following]);
      expect(engine.historyPage({}).total).toBe(5);
      expect(engine.taskDetails(ids[0]!)?.state).toBe("cancelled");
      engine.cancel(following);
      engine.removeProduct(productId);
      expect(engine.historyPage({}).total).toBe(0);
      expect(engine.taskDetails(ids[0]!)).toBeUndefined();
    } finally { await owner.stop(engine); }

  });
});

it("leaves a product and its history unchanged when its removal cannot be saved", async () => {
  return cases.use("petrina-history-", async owner => {
    const world = recordWorld(owner);
    const engine = world.start();
    let release = () => {};
    owner.onStop(() => release());
    try {
      engine.setPoolPaused(true);
      const productId = recordProduct(engine);
      const id = engine.addTask({ productId, title: "Keep on a failed removal" });
      // Hold terminal cleanup while this test exercises product-removal rollback.
      // Cancelling starts asynchronous deletion even without yielding JavaScript.
      release = engine.holdFollowUp(id);
      engine.cancel(id);
      engine.windowState();
      engine.taskDetails(id); // A cached finished task must not resurrect after successful removal.
      const captures = join(world.data, "captures", id);
      mkdirSync(captures, { recursive: true });
      // Simulate older storage protected by that hold, independent of normal terminal cleanup.
      writeFileSync(join(captures, "kept.png"), "picture");
      engine.store.database.run("CREATE TRIGGER fail_remove BEFORE DELETE ON task_history BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
      expect(() => engine.removeProduct(productId)).toThrow("storage failure");
      expect(existsSync(join(captures, "kept.png"))).toBe(true);
      expect(engine.activeState().products.some((product) => product.id === productId)).toBe(true);
      expect(engine.store.history.info().total).toBe(1);
      expect(engine.taskDetails(id)?.productId).toBe(productId);
      expect(engine.tracking.log.products().find((product) => product.id === productId)?.removedAt).toBeUndefined();
      engine.save();
      expect(engine.store.loadActive()!.products.some((product) => product.id === productId)).toBe(true);
      engine.store.database.run("DROP TRIGGER fail_remove");
      engine.removeProduct(productId);
      expect(existsSync(captures)).toBe(false);
      engine.save();
      expect(engine.store.history.info().total).toBe(0);
      expect(engine.taskDetails(id)).toBeUndefined();
      expect(engine.tracking.log.products().find((product) => product.id === productId)?.removedAt).toEqual(expect.any(Number));
    } finally { release(); await owner.stop(engine); }

  });
});

it("removes product pictures from actual storage without listing all history, preserving shared membership and rollback", async () => {
  return cases.use("petrina-history-", async owner => {
    const world = recordWorld(owner);
    const engine = world.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    try {
      engine.setPoolPaused(true);
      engine.s.products.push(...state([]).products as typeof engine.s.products);
      const exclusive = Array.from({ length: 303 }, (_, index) => reviewedTask(index, { productId: "one" }));
      const shared = reviewedTask(1_000, { productId: "two", activeProductId: "two", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local", completedStages: [], landed: { branch: "main", sha: productId } })) });
      const untouched = reviewedTask(1_001, { productId: "two" });
      // A finished copy with cleanup left to do remains in the active projection.
      const active = reviewedTask(1_002, { productId: "one", worktree: join(world.data, "worktrees", "one", "already-missing") });
      engine.s.tasks.push(...[...exclusive, shared, untouched, active] as typeof engine.s.tasks);
      engine.save();
      expect(engine.activeState().tasks.map((task) => task.id)).toEqual([active.id]);
      const pictured = [exclusive[0]!, shared, untouched];
      for (const task of pictured) {
        const folder = join(world.data, "captures", task.id);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "picture.png"), "kept unless its sole product is removed");
      }
      engine.s.inbox.push(...[active, exclusive[1]!, shared, untouched].map((task) => ({ id: `offer-${task.id}`, taskId: task.id, kind: "learnings" as const, title: "A saved lesson", body: "One lesson", at: 1, blocking: false })));
      const allowed = new Set([...pictured, active, exclusive[1]!].map((task) => task.id));
      const item = engine.store.history.item.bind(engine.store.history), get = engine.store.history.get.bind(engine.store.history);
      const summaries: string[] = [], bodies: string[] = [];
      engine.store.history.taskIds = () => { throw new Error("Removing a product must not enumerate its archived tasks"); };
      engine.store.history.all = () => { throw new Error("Removing a product must not reconstruct archived tasks"); };
      engine.store.history.item = (id) => {
        if (!allowed.has(id)) throw new Error(`No picture or inbox request needs this history summary: ${id}`);
        summaries.push(id);
        return item(id);
      };
      engine.store.history.get = (id) => {
        if (id !== shared.id) throw new Error(`No exclusive archived conversation is needed: ${id}`);
        bodies.push(id);
        return get(id);
      };
      try {
        engine.store.database.run("CREATE TRIGGER fail_capture_remove BEFORE DELETE ON task_history BEGIN SELECT RAISE(ABORT, 'capture removal storage failure'); END");
        expect(() => engine.removeProduct("one")).toThrow("capture removal storage failure");
        expect(engine.s.products.some((product) => product.id === "one")).toBe(true);
        expect(engine.s.inbox).toHaveLength(4);
        expect(item(shared.id)?.productIds).toEqual(["one", "two"]);
        for (const task of pictured) expect(existsSync(join(world.data, "captures", task.id, "picture.png"))).toBe(true);
        expect(engine.store.history.info().total).toBe(exclusive.length + 3);
        engine.store.database.run("DROP TRIGGER fail_capture_remove");
        engine.removeProduct("one");
        expect(engine.s.products.map((product) => product.id)).toEqual(["two"]);
        expect(engine.s.inbox.map((item) => item.taskId)).toEqual([shared.id, untouched.id]);
        expect(existsSync(join(world.data, "captures", exclusive[0]!.id))).toBe(false);
        for (const task of [shared, untouched]) expect(existsSync(join(world.data, "captures", task.id, "picture.png"))).toBe(true);
        expect(item(shared.id)?.productIds).toEqual(["two"]);
        const remaining = [withoutProduct(shared, "one")!, untouched];
        expect(engine.store.history.info().total).toBe(2);
        expect(engine.store.history.info().reviews).toEqual(reviewStats(remaining));
        expect(engine.store.history.info().reviewsByProduct.two).toEqual(reviewStats(remaining));
        expect(engine.historyPage({ productId: "one" }).total).toBe(0);
        expect(engine.historyPage({ productId: "two" }).total).toBe(2);
        expect(new Set(summaries)).toEqual(allowed);
        expect(bodies).toEqual([shared.id, shared.id]);
      } finally { engine.store.history.item = item; engine.store.history.get = get; }
    } finally { await owner.stop(engine); }

  });
});
});
