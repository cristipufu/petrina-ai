import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("broadcasts summaries, fetches complete details, and saves one streaming task without serializing its peers", async () => {
  const root = tempDir("petrina-live-task-storage-"); roots.push(root);
  const options = { admissionsClosed: true, agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null };
  let engine = new Engine(root, options);
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
    } finally { Reflect.deleteProperty(archived.session, "toJSON"); }
    const metadata = engine.store.database.query<{ value: string }, []>("SELECT value FROM kv WHERE key='state'").get()!.value;
    expect(metadata).not.toContain("LARGE-PRIVATE-HISTORY");
    await engine.shutdown(); engine = new Engine(root, options);
    expect(engine.taskDetails(one.id)!.session.at(-1)!.text).toBe("Progress beside an open archive");
    expect(engine.taskDetails(two.id)!.session[0]!.text).toBe(two.session[0]!.text);
  } finally { await engine.shutdown(); }
});
