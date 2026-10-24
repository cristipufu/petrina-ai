import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { Coordination } from "../src/coordination.js";
import { dispatch } from "../src/server.js";
import { removeDir, tempDir } from "./fixtures.js";

const roots: string[] = [], engines: Engine[] = [];
afterAll(async () => { await Promise.all(engines.map((engine) => engine.shutdown())); roots.forEach(removeDir); });
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] };
function start(data: string) {
  const engine = new Engine(data, options); engines.push(engine); engine.setPoolPaused(true); return engine;
}
function fixture() {
  const folder = tempDir("petrina-dependency-create-"); roots.push(folder);
  const data = join(folder, "data");
  const engine = start(data);
  engine.s.products.push({ id: "p", name: "Example", repo: "local/example", tone: "blue" });
  const add = (title: string) => engine.addTask({ productId: "p", title, backlog: true });
  return { engine, data, add };
}

it("persists the complete request before its first scheduling call and retains the same selection on retry after restart", async () => {
  const { engine, data, add } = fixture();
  const a = add("First"), b = add("Second");
  const input = { productId: "p", title: "Follow both", after: [a, b], clientId: "lost-reply" };
  const schedule = engine.schedule.bind(engine);
  let calls = 0;
  engine.schedule = () => {
    const saved = engine.store.load()!.tasks.find((task) => task.clientId === input.clientId)!;
    expect(saved.after).toEqual([a, b]);
    expect(saved.startedAt).toBeUndefined();
    expect(saved.journey?.[0]).toMatchObject({ kind: "wait" });
    calls++;
    schedule();
  };
  const id = await dispatch(engine, { name: "addTask", args: [input] }) as string;
  expect(calls).toBe(1);
  expect(engine.task(id)!.startedAt).toBeUndefined();
  await engine.shutdown();
  const restarted = start(data);
  expect(await dispatch(restarted, { name: "addTask", args: [input] })).toBe(id);
  expect(restarted.task(id)!.after).toEqual([a, b]);
  expect(restarted.activeState().tasks.filter((task) => task.clientId === input.clientId)).toHaveLength(1);
});

it("rejects unknown references, self and indirect cycles without changing the saved selection, and refuses edits after admission", async () => {
  const { engine, add } = fixture();
  const a = add("First"), b = add("Second"), c = add("Third");
  const before = engine.s.seq;
  expect(() => engine.addTask({ productId: "p", title: "Bad reference", after: [a, "removed"] })).toThrow("Remove");
  expect(engine.s.seq).toBe(before);
  expect(engine.activeState().tasks).toHaveLength(3);
  engine.setAfter(b, [a]); engine.setAfter(c, [b]);
  expect(() => engine.setAfter(a, [c])).toThrow("each other");
  expect(() => engine.setAfter(a, [a])).toThrow("itself");
  expect(engine.task(a)!.after).toBeUndefined();
  engine.queueTask(c);
  engine.setHeld(c, true); engine.moveToTop(c);
  const priority = engine.task(c)!.priority;
  engine.setAfter(c, [a, b]);
  expect(engine.task(c)!.held).toBe(true);
  expect(engine.task(c)!.priority).toBe(priority);
  engine.task(c)!.startedAt = Date.now();
  const saved = [...engine.task(c)!.after!];
  await expectRejection(dispatch(engine, { name: "setAfter", args: [c, []] }), "already started");
  expect(engine.task(c)!.after).toEqual(saved);
  const outside = await new Coordination(engine).call("task.dependencies", { taskId: c, after: [], requestId: "too-late" });
  expect(outside.outcome).toBe("invalid");
  expect(outside.message).toContain("already started");
  expect(engine.task(c)!.after).toEqual(saved);
});

it("keeps Backlog saves free of wait steps and only opens a wait for blockers after queueing, including after restart", async () => {
  const { engine, data, add } = fixture();
  const a = add("First"), b = add("Second");
  const id = engine.addTask({ productId: "p", title: "Draft", backlog: true, after: [a] });
  engine.setAfter(id, [a, b]);
  expect(engine.task(id)!.journey).toBeUndefined();
  expect(engine.task(id)!.statusLine).toBe("Review the request before queueing");
  expect(engine.task(id)!.timeline.at(-1)!.text).toContain("Second");
  await engine.shutdown();
  const restarted = start(data);
  await restarted.waitUntilReady();
  restarted.queueTask(id);
  expect(restarted.task(id)!.after).toEqual([a, b]);
  expect(restarted.task(id)!.journey![0]!.waitsOn).toHaveLength(2);
  const first = restarted.task(a)!;
  first.state = "done"; first.column = "done"; first.repository!.pr = { number: 1, url: "https://example.test/1", state: "merged", openedAt: 1 };
  restarted.schedule();
  expect(restarted.task(id)!.journey![0]!.endedAt).toBeUndefined();
  expect(restarted.task(id)!.startedAt).toBeUndefined();
  restarted.cancel(b);
  expect(restarted.task(id)!.journey![0]!.outcome).toContain("“First” landed");
  expect(restarted.task(id)!.journey![0]!.outcome).toContain("did not land: cancelled");
  const ready = restarted.addTask({ productId: "p", title: "Already landed", backlog: true, after: [a] });
  restarted.queueTask(ready);
  expect(restarted.task(ready)!.journey).toBeUndefined();
  restarted.setAfter(id, []);
  expect(restarted.task(id)!.after).toEqual([]);
});

it("creates dependencies through the outside operation atomically, rejects invalid requests and confirms a lost reply after restart", async () => {
  const { engine, data, add } = fixture();
  const a = add("First"), b = add("Second");
  const api = new Coordination(engine);
  const rejected = await api.call("task.add", { productId: "p", title: "Invalid", after: ["removed"], requestId: "invalid-create" });
  expect(rejected.outcome).toBe("invalid");
  expect(engine.activeState().tasks).toHaveLength(2);
  const input = { productId: "p", title: "Outside request", after: [a, b], backlog: true, requestId: "outside-create" };
  await engine.waitUntilReady();
  const schedule = engine.schedule.bind(engine);
  let admissions = 0;
  engine.schedule = () => {
    // The outside operation also owns a receipt transaction around the engine command.
    expect(engine.store.database.inTransaction).toBe(false);
    expect(engine.store.database.query("SELECT id FROM coordination_receipts WHERE id = ?").get(input.requestId)).not.toBeNull();
    expect(engine.store.load()!.tasks.find((task) => task.clientId === input.requestId)!.after).toEqual([a, b]);
    admissions++; schedule();
  };
  const result = await api.call("task.add", input);
  expect(result.outcome).toBe("completed");
  expect(admissions).toBe(1);
  const id = result.taskId as string;
  expect(engine.store.load()!.tasks.find((task) => task.id === id)!.after).toEqual([a, b]);
  expect(engine.task(id)!.journey).toBeUndefined();
  await engine.shutdown();
  const restarted = start(data);
  expect(await new Coordination(restarted).call("task.add", input)).toEqual(result);
  expect(restarted.activeState().tasks).toHaveLength(3);
  expect(restarted.task(id)!.after).toEqual([a, b]);
});

it("supplies compact finished picker summaries with authoritative blocking evidence, including older saved summaries", () => {
  const { engine, add } = fixture();
  const id = add("Closed delivery");
  const task = engine.task(id)!;
  task.state = "done"; task.column = "done"; task.finishedAt = 10;
  task.repositories = [{ productId: "p", delivery: "pull-request", completedStages: [], pr: { number: 1, url: "https://example.test/1", state: "closed", openedAt: 1 } }];
  engine.commitNow();
  // Emulate a summary saved before the compact blocking flag was introduced.
  engine.store.database.query("UPDATE task_history SET item = json_remove(item, '$.blocksDependents') WHERE id = ?").run(id);
  engine.store.history.get = () => { throw new Error("Picker must not load task bodies"); };
  const page = engine.historyPage({ taskId: id, limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.blocksDependents).toBe(true);
  expect(page.items[0]).not.toHaveProperty("session");
  expect(page.items[0]).not.toHaveProperty("description");
});
