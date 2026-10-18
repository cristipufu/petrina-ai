import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BUILT_IN_ROLES, historyAt, reviewStats, type Finding, type State, type Task } from "@petrina/core";
import { Store } from "../src/store.js";
import { serve } from "../src/server.js";
import { makeWorld, removeDir, tempDir, type World } from "./support.js";

const folders: string[] = [];
const worlds: World[] = [];
afterAll(() => { for (const folder of folders) removeDir(folder); for (const world of worlds) removeDir(world.dir); });

function task(number: number, changes: Partial<Task> = {}): Task {
  return {
    id: `task-${String(number).padStart(5, "0")}`, productId: number % 2 ? "one" : "two", title: `Finished change ${number}`,
    description: "The complete request stays in the detail, never in a history card.", area: "work", kind: "feature", priority: number,
    held: false, state: "done", column: "done", holdsSlot: false, approvePlan: false, delivery: "local", approveDelivery: false,
    stageIndex: 1, rounds: {}, sub: 0, fixing: false, statusLine: "Delivered", createdAt: number, finishedAt: 100 + Math.floor(number / 3),
    timeline: [], session: [{ id: `line-${number}`, at: number, from: "agent", text: "A large conversation is only read on demand." }],
    queued: [], objections: [], findings: [], prAge: 0, ...changes,
  };
}

const state = (tasks: readonly Task[]): State => ({ now: 1_000, seq: 10_000, products: [{ id: "one", name: "First", repo: "first/one", tone: "blue" }, { id: "two", name: "Second", repo: "second/two", tone: "green" }], roles: BUILT_IN_ROLES, tools: [], profiles: [], tasks, inbox: [], pool: { limit: 1, paused: true, toolCaps: {} } });
function store(): { file: string; db: Store } {
  const folder = tempDir("petrina-history-");
  folders.push(folder);
  const file = join(folder, "history.db");
  return { file, db: new Store(file) };
}

describe.concurrent("Finished work is indexed outside the live snapshot", () => {
  it("migrates an old snapshot atomically, keeps unfinished cleanup live, and reopens without losing any detail", () => {
    const { file, db } = store();
    const old = state([task(1), task(2, { state: "cancelled", column: "queue", finishedAt: undefined }), task(3, { state: "paused", column: "building" }), task(4, { worktree: "/unfinished-copy", startedAt: 5 })]);
    db.database.query("INSERT INTO kv(key, value, updated_at) VALUES('state', ?, 1)").run(JSON.stringify(old));
    try {
      const active = db.loadActive()!;
      expect(active.tasks.map((entry) => entry.id)).toEqual(["task-00003", "task-00004"]);
      expect(db.history.info().total).toBe(3);
      expect(db.history.get("task-00001")).toEqual(old.tasks[0]);
      expect(db.history.page({}).items.map((entry) => entry.id)).toEqual(["task-00004", "task-00001", "task-00002"]);
      const saved = db.database.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'state'").get()!;
      expect(JSON.parse(saved.value).tasks.map((entry: Task) => entry.id)).toEqual(active.tasks.map((entry) => entry.id));
    } finally { db.close(); }
    const reopened = new Store(file);
    try {
      expect(reopened.loadActive()!.tasks.map((entry) => entry.id)).toEqual(["task-00003", "task-00004"]);
      expect(reopened.load()!.tasks).toHaveLength(4);
      expect(reopened.history.info().total).toBe(3);
      expect(reopened.history.get("task-00001")?.session[0]?.text).toBe(old.tasks[0]!.session[0]!.text);
    } finally { reopened.close(); }
  });

  it("returns only one lightweight page, with stable cursors, exact filters and indexed seeks", () => {
    const { db } = store();
    const tasks = Array.from({ length: 501 }, (_, index) => task(index, index % 11 === 0 ? { title: `Browser screenshot ${index}` } : {}));
    try {
      db.save(state(tasks));
      expect(db.loadActive()!.tasks).toEqual([]);
      let cursor: string | undefined;
      const seen: string[] = [];
      do {
        const page = db.history.page({ productId: "one", limit: 17, ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(250);
        expect(page.items.length).toBeLessThanOrEqual(17);
        for (const item of page.items) {
          expect("session" in item).toBe(false);
          expect("description" in item).toBe(false);
          expect(item.productId).toBe("one");
          seen.push(item.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const expected = tasks.filter((entry) => entry.productId === "one").sort((a, b) => historyAt(b) - historyAt(a) || (a.id < b.id ? 1 : -1)).map((entry) => entry.id);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      const first = db.history.page({ limit: 8 });
      db.save(state([task(999, { finishedAt: 99_999 })]));
      const next = db.history.page({ limit: 8, cursor: first.nextCursor });
      expect(next.items.every((item) => historyAt(item) <= historyAt(first.items.at(-1)!))).toBe(true);
      expect(next.items.some((item) => first.items.some((before) => before.id === item.id))).toBe(false);
      expect(db.history.page({ query: "browser screen", limit: 100 }).total).toBe(46);
      expect(db.history.page({ query: 'browser" OR "absent', limit: 100 }).items).toEqual([]);
      expect(db.history.page({ productId: "missing" })).toEqual({ items: [], total: 0 });
      expect(() => db.history.page({ cursor: "broken" })).toThrow("Start from the first page");
      const plans = db.database.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT item FROM task_history WHERE product_id = 'one' AND (finished_at, id) < (150, 'task-00100') ORDER BY finished_at DESC, id DESC LIMIT 24").all();
      expect(plans.some((row) => row.detail.includes("task_history_product_newest"))).toBe(true);
      expect(plans.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    } finally { db.close(); }
  });

  it("keeps review/verifier totals and recent timing records exact when a saved terminal task changes", () => {
    const { db } = store();
    const finding: Finding = { id: "f", text: "A real issue", evidence: "Reproduced", severity: "blocking", status: "fixed", raisedBy: "sol", confirmedBy: ["opus"], roleId: "security-reviewer", votes: [{ by: "sol", toolId: "codex", verdict: "real", reason: "Reproduced" }], verification: { by: "sol", verdict: "real", reason: "Confirmed", at: 1 } };
    const plan = { stages: [{ id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["sol"], roleIds: ["security-reviewer"] }], rationale: "Review", plannerProfileId: "sol" };
    const tasks = Array.from({ length: 16 }, (_, index) => task(index, { plan, stageIndex: 1, rounds: { review: index % 3 + 1 }, findings: index % 2 ? [{ ...finding, id: `f-${index}` }] : [], steps: [{ roleId: "builder", repeat: false, worked: 60_000 + index, at: index }] }));
    try {
      db.save(state(tasks));
      const first = db.history.info();
      expect(first.reviews).toEqual(reviewStats(tasks));
      expect(first.reviewsByProduct.one).toEqual(reviewStats(tasks.filter((entry) => entry.productId === "one")));
      expect(first.steps).toHaveLength(10);
      expect(first.steps.map((step) => step.at).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, index) => index + 6));
      expect(db.history.usesRole("security-reviewer")).toBe(true);
      const changed = { ...tasks[1]!, state: "cancelled" as const, clientId: "original-request", cleanup: { removedAt: 1, reviewCopiesRemovedAt: 1 } };
      tasks[1] = changed;
      db.save(state([changed]));
      expect(db.history.info().total).toBe(16);
      expect(db.history.info().reviews).toEqual(reviewStats(tasks));
      expect(db.history.byClient("original-request")).toBe(changed.id);
      const revision = db.history.info().revision;
      db.save(state([changed]));
      expect(db.history.info().revision).toBe(revision);
      const remaining = tasks.filter((entry) => entry.productId === "two");
      db.removeProduct("one", state([]));
      expect(db.history.info().total).toBe(remaining.length);
      expect(db.history.info().reviews).toEqual(reviewStats(remaining));
      expect(db.history.page({ productId: "one" }).items).toEqual([]);
      expect(db.history.byClient("original-request")).toBeUndefined();
    } finally { db.close(); }
  });

  it("rolls back both the live snapshot and archive totals if migration is interrupted", () => {
    const { db } = store();
    const before = state([task(1, { state: "paused" })]);
    db.save(before);
    db.database.run("CREATE TRIGGER fail_history BEFORE INSERT ON task_history WHEN NEW.id = 'task-00003' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    try {
      expect(() => db.save(state([task(2), task(3)]))).toThrow("interrupted");
      expect(db.loadActive()).toEqual(before);
      expect(db.history.info().total).toBe(0);
      expect(db.history.get("task-00002")).toBeUndefined();
      db.database.run("DROP TRIGGER fail_history");
      db.save(state([task(2), task(3)]));
      expect(db.history.info().total).toBe(2);
    } finally { db.close(); }
  });

  it("reads a diagnostic snapshot without writes while finished cleanup is still live", () => {
    const { db } = store();
    const waiting = task(1, { worktree: "/copy-awaiting-cleanup", startedAt: 1 });
    const archived = task(2);
    try {
      db.save(state([waiting, archived]));
      // A diagnostic reader can inspect an engine that is writing its cleanup result at the same
      // time. It must not run startup migration or try to upgrade its read snapshot to a write.
      db.database.run("PRAGMA query_only = ON");
      const result = db.load()!;
      expect(result.tasks.map((entry) => entry.id).sort()).toEqual([waiting.id, archived.id].sort());
      expect(result.tasks.find((entry) => entry.id === waiting.id)?.worktree).toBe(waiting.worktree);
      expect(result.tasks.find((entry) => entry.id === archived.id)?.session).toEqual(archived.session);
    } finally { db.close(); }
  });

  it("keeps archived task details and dependencies available without sending bodies to the window", async () => {
    const world = makeWorld("history-runtime");
    worlds.push(world);
    let engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
      const ids = Array.from({ length: 5 }, (_, index) => engine.addTask({ productId, title: `Review later ${index}`, clientId: `request-${index}` }));
      for (const id of ids) engine.cancel(id);
      const window = engine.windowState();
      expect(window.tasks).toEqual([]);
      expect(window.history?.total).toBe(5);
      expect(engine.activeState().tasks).toEqual([]);
      expect(engine.getState().tasks).toHaveLength(5);
      expect(engine.getState().history).toBeUndefined();
      expect(engine.historyPage({ productId, limit: 2 }).items).toHaveLength(2);
      expect(engine.taskDetails(ids[0]!)?.title).toBe("Review later 0");
      expect(engine.addTask({ productId, title: "Lost reply", clientId: "request-0" })).toBe(ids[0]!);
      const following = engine.addTask({ productId, title: "After the finished work" });
      engine.setAfter(following, [ids[0]!]);
      expect(engine.blockers(engine.task(following)!)).toEqual([]);
      expect(engine.windowState().history?.dependencies?.find((entry) => entry.id === ids[0])?.title).toBe("Review later 0");
      const server = serve(engine, { port: 0, token: "history-fixture" });
      try {
        const raw = await (await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { authorization: "Bearer history-fixture" } })).json() as State;
        expect(raw.tasks.map((entry) => entry.id)).toEqual([following]);
        expect(raw.history?.total).toBe(5);
        expect(raw.history?.dependencies?.some((entry) => "session" in entry)).toBe(false);
      } finally { server.stop(true); }
      await engine.shutdown();
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
    } finally { await engine.shutdown(); }
  });

  it("leaves a product and its history unchanged when its removal cannot be saved", async () => {
    const world = makeWorld("history-removal-rollback");
    worlds.push(world);
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
      const id = engine.addTask({ productId, title: "Keep on a failed removal" });
      engine.cancel(id);
      engine.windowState();
      engine.taskDetails(id); // A cached finished task must not resurrect after successful removal.
      engine.store.database.run("CREATE TRIGGER fail_remove BEFORE DELETE ON task_history BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
      expect(() => engine.removeProduct(productId)).toThrow("storage failure");
      expect(engine.activeState().products.some((product) => product.id === productId)).toBe(true);
      expect(engine.store.history.info().total).toBe(1);
      expect(engine.taskDetails(id)?.productId).toBe(productId);
      expect(engine.tracking.log.products().find((product) => product.id === productId)?.removedAt).toBeUndefined();
      engine.save();
      expect(engine.store.loadActive()!.products.some((product) => product.id === productId)).toBe(true);
      engine.store.database.run("DROP TRIGGER fail_remove");
      engine.removeProduct(productId);
      engine.save();
      expect(engine.store.history.info().total).toBe(0);
      expect(engine.taskDetails(id)).toBeUndefined();
      expect(engine.tracking.log.products().find((product) => product.id === productId)?.removedAt).toEqual(expect.any(Number));
    } finally { await engine.shutdown(); }
  });
});
