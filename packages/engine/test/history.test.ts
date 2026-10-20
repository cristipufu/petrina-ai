import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, historyAt, reviewStats, withoutProduct, type Finding, type State, type Task } from "@petrina/core";
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
    queued: [], objections: [], findings: [], ...changes,
  };
}

const state = (tasks: readonly Task[]): State => ({ now: 1_000, seq: 10_000, products: [{ id: "one", name: "First", repo: "first/one", tone: "blue" }, { id: "two", name: "Second", repo: "second/two", tone: "green" }], roles: BUILT_IN_ROLES, tools: [], profiles: [], tasks, inbox: [], pool: { limit: 1, paused: true, toolCaps: {} } });
function store(): { file: string; db: Store } {
  const folder = tempDir("petrina-history-");
  folders.push(folder);
  const file = join(folder, "history.db");
  return { file, db: new Store(file) };
}

it("rolls active-id tracking back after a failed save and avoids rewriting identical metadata", () => {
  const { db } = store();
  try {
    const empty = state([]), added = state([task(1, { state: "backlog", finishedAt: undefined })]);
    db.save(empty);
    db.database.run("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'snapshot refused'); END");
    expect(() => db.save(added, [], [], [])).toThrow("snapshot refused");
    expect(db.database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM active_tasks").get()!.n).toBe(0);
    db.database.run("DROP TRIGGER reject_snapshot");
    db.save(added, [], [], []);
    expect(db.loadActive()!.tasks.map((entry) => entry.id)).toEqual(added.tasks.map((entry) => entry.id));
    db.database.run("CREATE TRIGGER reject_same_snapshot BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'unnecessary metadata update'); END");
    expect(() => db.save(added, [], [], [])).not.toThrow();
    db.database.run("DROP TRIGGER reject_same_snapshot");
  } finally { db.close(); }
});

function reviewedTask(number: number, changes: Partial<Task> = {}): Task {
  const finding: Finding = {
    id: `finding-${number}`, text: "Checked behaviour", severity: "blocking", status: number % 2 ? "fixed" : "dismissed",
    raisedBy: "sol", confirmedBy: ["opus"], roleId: "security-reviewer",
    votes: [{ by: "sol", toolId: "codex", verdict: "real", reason: "Reproduced" }],
    verification: { by: "sol", verdict: "real", reason: "Confirmed", at: number },
  };
  return task(number, {
    productId: "one", clientId: `request-${number}`, state: number % 7 === 0 ? "cancelled" : "done",
    plan: { stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "security-reviewer", profileIds: ["sol"] }], rationale: "Review", plannerProfileId: "sol" },
    rounds: { review: number % 4 + 1 }, findings: [finding], sentBack: number % 3,
    steps: [{ roleId: "builder", repeat: false, worked: number + 60_000, at: number }], ...changes,
  });
}

describe.concurrent("Finished work is indexed outside the live snapshot", () => {
  it("lists archived task ids through primary and secondary product membership", () => {
    const { db } = store();
    const exclusive = task(1, { productId: "one" });
    const shared = task(3, { productId: "two", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local", completedStages: [] })) });
    try {
      db.save(state([exclusive, shared]));
      expect(db.history.taskIds("one").sort()).toEqual([exclusive.id, shared.id].sort());
      expect(db.history.taskIds("two")).toEqual([shared.id]);
      db.removeProduct("one", { ...state([]), products: state([]).products.filter((product) => product.id !== "one") });
      expect(db.history.taskIds("one")).toEqual([]);
      expect(db.history.taskIds("two")).toEqual([shared.id]);
    } finally { db.close(); }
  });

  it("removes a large mixed product history without reading exclusive task bodies or losing shared reviews", () => {
    const { file, db } = store();
    const shared = new Set([9, 201, 502]);
    const tasks = Array.from({ length: 503 }, (_, index) => reviewedTask(index, {
      session: [{ id: `line-${index}`, at: index, from: "agent", text: "Conversation history ".repeat(200) }],
      ...(shared.has(index) ? { activeProductId: "one", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local" as const, completedStages: [], landed: { branch: "main", sha: productId } })) } : {}),
    }));
    const untouched = reviewedTask(1_000, { productId: "two" });
    const remaining = [...tasks.flatMap((entry) => { const kept = withoutProduct(entry, "one"); return kept ? [kept] : []; }), untouched];
    try {
      db.save(state([...tasks, untouched]));
      // An exclusive task's conversation is irrelevant to deleting it. Refuse such reads so this
      // case catches a return to loading full bodies, regardless of their size or the batch size.
      const get = db.history.get.bind(db.history);
      const reads: string[] = [];
      db.history.get = (id) => {
        if (!tasks.some((entry) => entry.id === id && entry.repositories)) throw new Error(`Unneeded exclusive task body: ${id}`);
        reads.push(id);
        return get(id);
      };
      try { db.removeProduct("one", { ...state([]), products: state([]).products.filter((entry) => entry.id !== "one") }); }
      finally { db.history.get = get; }
      expect(reads.sort()).toEqual(tasks.filter((entry) => entry.repositories).map((entry) => entry.id).sort());
      expect(db.history.info().total).toBe(remaining.length);
      expect(db.history.info().reviews).toEqual(reviewStats(remaining));
      expect(db.history.info().reviewsByProduct.two).toEqual(reviewStats(remaining));
      expect(db.history.page({ productId: "one" })).toEqual({ items: [], total: 0 });
      expect(db.history.page({ productId: "two" }).total).toBe(remaining.length);
      expect(db.history.info().products).toEqual([{ productId: "two", done: remaining.filter((entry) => entry.state === "done").length, cancelled: remaining.filter((entry) => entry.state === "cancelled").length, shared: 0, blocked: 0 }]);
      for (const entry of remaining) {
        expect(db.history.get(entry.id)).toEqual(entry);
        expect(db.history.byClient(entry.clientId!)).toBe(entry.id);
      }
      expect(db.history.byClient("request-501")).toBeUndefined();
      expect(db.history.page({ query: "Finished change 501" }).items).toEqual([]);
      expect(db.history.info().steps.map((step) => step.at).sort((a, b) => a - b)).toEqual(remaining.map((entry) => entry.steps![0]!.at).sort((a, b) => a - b));
      const counts = db.database.query<{ memberships: number; bodies: number; steps: number; roles: number }, []>("SELECT (SELECT count(*) FROM task_history_products) AS memberships, (SELECT count(*) FROM task_history) AS bodies, (SELECT count(*) FROM task_history_steps) AS steps, (SELECT count(*) FROM task_history_roles) AS roles").get()!;
      expect(counts).toEqual({ memberships: remaining.length, bodies: remaining.length, steps: remaining.length, roles: remaining.length });
      const plan = db.database.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT p.task_id FROM task_history_products p JOIN task_history h ON h.id=p.task_id WHERE p.product_id='one' AND (p.finished_at,p.task_id)<(150,'task-00150') ORDER BY p.finished_at DESC,p.task_id DESC LIMIT 100").all();
      expect(plan.some((row) => row.detail.includes("task_history_membership_newest"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    } finally { db.close(); }
    const reopened = new Store(file);
    try {
      expect(reopened.history.info().reviews).toEqual(reviewStats(remaining));
      expect(reopened.history.page({ productId: "two" }).total).toBe(remaining.length);
      expect(reopened.history.page({ productId: "one" }).total).toBe(0);
    } finally { reopened.close(); }
  });

  for (const failure of ["later batch", "snapshot"] as const) it(`rolls back every removal batch and retained task when the ${failure} cannot be saved`, () => {
    const { file, db } = store();
    const tasks = Array.from({ length: 360 }, (_, index) => reviewedTask(index, index === 350 ? {
      activeProductId: "one", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local" as const, completedStages: [], landed: { branch: "main", sha: productId } })),
    } : {}));
    const shared = tasks[350]!;
    let before: ReturnType<Store["history"]["info"]>;
    try {
      db.save(state(tasks));
      before = structuredClone(db.history.info());
      const snapshot = db.loadActive()!;
      db.database.run(failure === "later batch"
        ? "CREATE TRIGGER fail_batched_removal BEFORE DELETE ON task_history WHEN OLD.id='task-00150' BEGIN SELECT RAISE(ABORT, 'interrupted removal'); END"
        : "CREATE TRIGGER fail_batched_removal BEFORE UPDATE ON kv WHEN NEW.key='state' BEGIN SELECT RAISE(ABORT, 'interrupted removal'); END");
      expect(() => db.removeProduct("one", { ...state([]), products: state([]).products.filter((entry) => entry.id !== "one") })).toThrow("interrupted removal");
      expect(db.loadActive()).toEqual(snapshot);
      expect(db.history.info()).toEqual(before);
      expect(db.history.page({ productId: "one" }).total).toBe(tasks.length);
      expect(db.history.page({ productId: "two" }).total).toBe(1);
      expect(db.history.get(shared.id)).toEqual(shared);
      expect(db.history.needsUpdate([shared])).toBe(false);
      expect(db.history.get("task-00359")).toEqual(tasks[359]);
      db.database.run("DROP TRIGGER fail_batched_removal");
    } finally { db.close(); }
    const reopened = new Store(file);
    try {
      expect(reopened.history.info()).toEqual(before!);
      expect(reopened.history.get(shared.id)).toEqual(shared);
      reopened.removeProduct("one", { ...state([]), products: state([]).products.filter((entry) => entry.id !== "one") });
      expect(reopened.history.info().total).toBe(1);
      expect(reopened.history.info().reviews).toEqual(reviewStats([shared]));
      expect(reopened.history.page({ productId: "two" }).total).toBe(1);
    } finally { reopened.close(); }
  });

  it("indexes shared work under each product once and preserves it until its last product is removed", () => {
    const { file, db } = store();
    const shared = task(1, { productId: "one", activeProductId: "one", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local", completedStages: [], landed: { branch: "main", sha: productId }, workProduct: { id: productId, name: productId === "one" ? "First" : "Second", repo: `acme/${productId}`, defaultBranch: "main" } })) });
    try {
      db.save(state([shared, task(2)]));
      expect(db.history.info().total).toBe(2);
      expect(db.history.page({ productId: "one" }).total).toBe(1);
      expect(db.history.page({ productId: "two" }).total).toBe(2);
      const card = db.history.page({ productId: "one" }).items[0]!;
      expect(card.productIds).toEqual(["one", "two"]);
      expect(card.products?.map((product) => product.name)).toEqual(["First", "Second"]);
      expect(card.deliveries?.map((work) => work.landed?.sha)).toEqual(["one", "two"]);
      expect("session" in card).toBe(false);
      expect("repositories" in card).toBe(false);
      const plan = db.database.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT h.item FROM task_history_products p JOIN task_history h ON h.id=p.task_id WHERE p.product_id='one' ORDER BY p.finished_at DESC, p.task_id DESC LIMIT 24").all();
      expect(plan.some((row) => row.detail.includes("task_history_membership_newest"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
      db.removeProduct("one", state([]));
      expect(db.history.info().total).toBe(2);
      expect(db.history.page({ productId: "one" }).total).toBe(0);
      expect(db.history.page({ productId: "two" }).total).toBe(2);
      expect(db.history.get(shared.id)?.repositories?.[0]?.removed).toBe(true);
      expect(db.history.get(shared.id)?.productId).toBe("two");
      expect(db.history.get(shared.id)?.session).toEqual(shared.session);
      expect(db.history.info().products.find((product) => product.productId === "two")?.shared).toBe(0);
    } finally { db.close(); }
    const reopened = new Store(file);
    try {
      expect(reopened.history.page({ productId: "two" }).total).toBe(2);
      expect(reopened.history.get(shared.id)?.repositories?.[0]?.workProduct?.name).toBe("First");
      reopened.removeProduct("two", state([]));
      expect(reopened.history.info().total).toBe(0);
      expect(reopened.history.get(shared.id)).toBeUndefined();
    } finally { reopened.close(); }
  });

  it("migrates the earlier history index without losing shared memberships or counting a task twice", () => {
    const { file, db } = store();
    const shared = task(3, { repositories: ["one", "two"].map((productId) => ({ productId, delivery: "local", completedStages: [] })) });
    db.save(state([shared]));
    db.database.run("DROP TABLE task_history_products");
    db.close();
    const reopened = new Store(file);
    try {
      expect(reopened.history.info().total).toBe(1);
      for (const productId of ["one", "two"]) {
        expect(reopened.history.page({ productId }).items.map((item) => item.id)).toEqual([shared.id]);
        expect(reopened.history.info().products.find((product) => product.productId === productId)?.shared).toBe(1);
      }
    } finally { reopened.close(); }
  });

  it("retains removal warnings in compact totals while a cancelled shared task still has an open pull request", () => {
    const { db } = store();
    const shared = task(1, { state: "cancelled", repositories: ["one", "two"].map((productId) => ({ productId, delivery: "pull-request", completedStages: [], pr: { number: 1, url: `https://github.com/acme/${productId}/pull/1`, state: "open", openedAt: 1 } })) });
    try {
      db.save(state([shared]));
      expect(db.loadActive()!.tasks.map((task) => task.id)).toEqual([shared.id]);
      expect(db.history.info().products.every((product) => product.blocked === 1)).toBe(true);
      const closed = { ...shared, repositories: shared.repositories!.map((work) => ({ ...work, pr: { ...work.pr!, state: "merged" as const } })) };
      db.save(state([closed]));
      expect(db.history.info().products.every((product) => product.blocked === 0)).toBe(true);
    } finally { db.close(); }
  });

  it("retries an interrupted membership migration from the original history", () => {
    const { file, db } = store();
    db.save(state([task(1)]));
    db.database.run("DROP TABLE task_history_products");
    db.database.run("CREATE TRIGGER fail_membership BEFORE UPDATE ON task_history BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    db.close();
    expect(() => new Store(file)).toThrow("interrupted");
    // A failed migration did not leave behind an empty index that a restart could mistake for complete.
    const raw = new Database(file);
    expect(raw.query("SELECT 1 FROM sqlite_master WHERE name='task_history_products'").get()).toBeNull();
    raw.run("DROP TRIGGER fail_membership");
    raw.close();
    const restored = new Store(file);
    try { expect(restored.history.page({ productId: "one" }).total).toBe(1); }
    finally { restored.close(); }
  });

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
      expect(JSON.parse(saved.value).tasks).toEqual([]);
      expect(JSON.parse(saved.value).taskIds).toEqual(active.tasks.map((entry) => entry.id));
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
    let release = () => {};
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
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
    } finally { release(); await engine.shutdown(); }
  });

  it("removes product pictures from actual storage without listing all history, preserving shared membership and rollback", async () => {
    const world = makeWorld("history-capture-removal");
    worlds.push(world);
    const engine = world.start({ agentCommand: () => undefined, codexCommand: null, grokCommand: null, terminals: () => [] });
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
    } finally { await engine.shutdown(); }
  });
});
