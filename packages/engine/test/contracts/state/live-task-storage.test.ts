import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";

import { waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("coalesces streamed revisions and persists the final text on completion and shutdown", async () => {
  return cases.use("petrina-stream-revisions-", async owner => {
  const root = owner.root;
  const options = { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   };
  let engine = owner.open(root, options);
  try {
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Streaming", backlog: true }))!;
    engine.say(task, "agent", "First words"); engine.commitNow(task);
    const revision = () => engine.windowState().tasks.find((entry) => entry.id === task.id)!.detailsRevision;
    const before = revision();
    expect(engine.taskDetails(task.id)!.detailsRevision).toBe(before);
    const notifications: string[] = [];
    const off = engine.subscribe(() => notifications.push(revision()!));
    owner.onStop(() => off());
    for (let chunk = 0; chunk < 100; chunk++) { task.session[0]!.text = `Latest chunk ${chunk}`; engine.noteStream(task); }
    expect(revision()).toBe(before);
    expect(notifications).toHaveLength(0);
    await waitFor(() => revision() !== before, "one coalesced message notification");
    expect(new Set(notifications).size).toBe(1);
    expect(engine.taskDetails(task.id)!.session[0]!.text).toBe("Latest chunk 99");
    expect(engine.taskDetails(task.id)!.detailsRevision).toBe(revision()!);
    const beforeSave = revision();
    task.session[0]!.text = "Stream flushed by an ordinary save"; engine.noteStream(task); engine.save(false);
    expect(revision()).not.toBe(beforeSave);
    expect(notifications.at(-1)).toBe(revision()!);
    expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.session[0]!.text).toBe("Stream flushed by an ordinary save");
    task.session[0]!.text = "Completed turn"; engine.noteStream(task); engine.commitNow(task);
    expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.session[0]!.text).toBe("Completed turn");
    task.session[0]!.text = "Last words before shutdown"; engine.noteStream(task);
    off(); await owner.stop(engine); engine = owner.open(root, options);
    expect(engine.taskDetails(task.id)!.session[0]!.text).toBe("Last words before shutdown");
  } finally { await owner.stop(engine); }

  });
});


it("broadcasts summaries, fetches complete details, and saves one streaming task without serializing its peers", async () => {
  return cases.use("petrina-live-task-storage-", async owner => {
  const root = owner.root;
  const options = { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   };
  let engine = owner.open(root, options);
  try {
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", path: join(root, "product"), tone: "blue" });
    const one = engine.task(engine.addTask({ productId: "p", title: "One", backlog: true }))!;
    const two = engine.task(engine.addTask({ productId: "p", title: "Two", backlog: true }))!;
    two.session = [{ id: "large", at: 1, from: "agent", text: "LARGE-PRIVATE-HISTORY".repeat(10_000) }];
    engine.commitNow();
    const bytes = JSON.stringify(engine.windowState()).length;
    expect(bytes).toBeLessThan(JSON.stringify(engine.getState()).length / 5);
    expect(engine.windowState().tasks.every((task) => task.detailsOmitted && !task.session.length && !task.timeline.length && !task.journey)).toBe(true);
    expect(engine.taskDetails(two.id)!.session[0]!.text).toContain("LARGE-PRIVATE-HISTORY");
    const oldRevision = engine.windowState().tasks.find((task) => task.id === two.id)!.detailsRevision;
    Object.defineProperty(two.session, "toJSON", { configurable: true, value: () => { throw new Error("Untouched task was serialized"); } });
    try {
      engine.say(one, "agent", "New progress");
      engine.commitNow(one);
      expect(engine.windowState().tasks.find((task) => task.id === two.id)!.detailsRevision).toBe(oldRevision);
    } finally { Reflect.deleteProperty(two.session, "toJSON"); }
    engine.cancel(two.id);
    // Finished work can remain in runtime state while delivery cleanup settles.
    engine.store.save(engine.activeState(), []);
    Object.defineProperty(two.session, "toJSON", { configurable: true, value: () => { throw new Error("Unchanged finished task was serialized"); } });
    try { engine.store.save(engine.activeState(), [], [], [one.id]); }
    finally { Reflect.deleteProperty(two.session, "toJSON"); }
    engine.commitNow();
    const archived = engine.task(two.id)!;
    Object.defineProperty(archived.session, "toJSON", { configurable: true, value: () => { throw new Error("Untouched archive was serialized"); } });
    try {
      engine.say(one, "agent", "Progress beside an open archive");
      engine.commitNow(one);
      engine.commitNow();
    } finally { Reflect.deleteProperty(archived.session, "toJSON"); }
    const metadata = engine.store.database.query<{ value: string }, []>("SELECT value FROM kv WHERE key='state'").get()!.value;
    expect(metadata).not.toContain("LARGE-PRIVATE-HISTORY");
    await owner.stop(engine); engine = owner.open(root, options);
    expect(engine.taskDetails(one.id)!.session.at(-1)!.text).toBe("Progress beside an open archive");
    expect(engine.taskDetails(two.id)!.session[0]!.text).toBe(two.session[0]!.text);
  } finally { await owner.stop(engine); }

  });
});
