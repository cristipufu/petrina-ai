import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import type { TaskSource, WorkChoice } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Coordination } from "../src/coordination.js";
import { removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
async function fixture() {
  const root = tempDir("petrina-source-validation-"); roots.push(root);
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null } });
  await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
  engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "p", title: "Source choices", backlog: true }))!;
  engine.raise(task, "plan", "Check the plan", false);
  return { engine, task, sources: engine["sources"] };
}
const choice = (name: string): WorkChoice => ({ productId: "p", startFrom: { kind: "branch", name }, delivery: "local" });
const resolved = (branch: string): TaskSource => ({ product: { id: "p", name: "Product", repo: "local/p" }, start: { kind: "branch", branch }, destination: { mode: "local", kind: "branch", repo: "local/p", branch: "main" }, confirmed: false });

it("saves in-flight single-product validation and blocks edits and approval until it finishes", async () => {
  const { engine, task, sources } = await fixture();
  let finish!: (source: TaskSource) => void;
  const resolve = spyOn(sources, "resolve").mockImplementation(() => new Promise(done => { finish = done; }));
  try {
    const pending = engine.setTaskStart(task.id, choice("one"));
    expect(task.workValidating).toBe(true);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.workValidating).toBe(true);
    await expect(engine.setTaskStart(task.id, choice("two"))).rejects.toThrow("Wait for validation");
    expect(() => sources.confirm(task)).toThrow("Wait for every product choice");
    finish(resolved("one")); await pending;
    expect(task.workValidating).toBe(false); expect(task.workError).toBeUndefined();
    expect(task.proposedSource?.start.branch).toBe("one");
  } finally { resolve.mockRestore(); await engine.shutdown(); }
});

it("ignores superseded source successes and failures without clearing the newer validation", async () => {
  const { engine, task, sources } = await fixture();
  const jobs: { resolve: (source: TaskSource) => void; reject: (error: Error) => void }[] = [];
  const resolve = spyOn(sources, "resolve").mockImplementation(() => new Promise((resolve, reject) => { jobs.push({ resolve, reject }); }));
  try {
    for (const failed of [false, true]) {
      const old = sources.propose(task, [choice("old")]), latest = sources.propose(task, [choice("latest")]);
      const earlier = jobs.shift()!, current = jobs.shift()!;
      if (failed) earlier.reject(new Error("Old failure")); else earlier.resolve(resolved("old"));
      await old;
      expect(task.workValidating).toBe(true); expect(task.proposedSource).toBeUndefined();
      expect(task.workError).toContain("Checking the product");
      current.resolve(resolved("latest")); await latest;
      expect(task.workValidating).toBe(false); expect(task.workError).toBeUndefined();
      expect(task.proposedSource?.start.branch).toBe("latest");
    }
  } finally { resolve.mockRestore(); await engine.shutdown(); }
});

it("rejects a source edit for an absent shared product without clearing the lead choice, including through coordination", async () => {
  const { engine, task } = await fixture();
  task.workRows = [{ choice: { ...choice("one"), lead: true } }];
  const before = JSON.stringify(task.workRows);
  try {
    const bad = { ...choice("missing"), productId: "missing", lead: true };
    await expect(engine.setTaskStart(task.id, bad)).rejects.toThrow("not in this task's product choices");
    expect(JSON.stringify(task.workRows)).toBe(before);
    const result = await new Coordination(engine).call("task.source", { taskId: task.id, choice: bad, requestId: "missing-product" });
    expect(result.outcome).toBe("invalid"); expect(JSON.stringify(task.workRows)).toBe(before);
  } finally { await engine.shutdown(); }
});

it("shows an addition's validation error without an Error prefix", async () => {
  const { engine, task, sources } = await fixture();
  const source = resolved("main"); source.product = { id: "new", name: "New", repo: "acme/new" };
  task.workRows = [{ choice: { ...choice("main"), productId: "new", repo: "acme/new" }, source }];
  const resolve = spyOn(sources, "resolve").mockRejectedValue(new Error("The branch is not on GitHub"));
  try {
    await sources.configureAddition(task, "acme/new", "New", join(engine.dataDir, "unused-clone"));
    expect(task.workRows[0]!.error).toBe("The branch is not on GitHub");
  } finally { resolve.mockRestore(); await engine.shutdown(); }
});
