import { afterAll, describe, expect, it } from "bun:test";
import { detachRepositoryState, executionFor } from "../src/repository-context.js";
import { Learnings } from "../src/learnings.js";
import { makeWorld, removeDir, waitFor, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach((world) => removeDir(world.dir)));

async function fixture(name: string) {
  const first = makeWorld(`context-first-${name}`), second = makeWorld(`context-second-${name}`);
  worlds.push(first, second);
  const start = () => first.start({ agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
  const engine = start();
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const products = [first, second].map((world, index) => ({ id: index ? "second" : "first", name: index ? "Second" : "First", repo: index ? "acme/second" : "acme/first", path: world.clone, tone: "blue" as const }));
  engine.s.products.push(...products);
  const id = engine.addTask({ productId: "first", title: "Keep each repository's execution state", backlog: true });
  const task = engine.task(id)!;
  task.repositories = products.map((product) => ({ productId: product.id, worktree: product.path, delivery: "local", branch: `task-${product.id}`, report: { summary: `${product.id} report`, changes: [] }, builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "sol", sessionId: `${product.id}-conversation` }, completedStages: [] }));
  task.activeProductId = "first";
  detachRepositoryState(task);
  return { engine, start, task, id };
}

describe("explicit repository execution contexts", () => {
  it("keeps bound owners and canonical state through snapshots, saves and restart", async () => {
    const f = await fixture("snapshots");
    let engine = f.engine;
    try {
      const first = executionFor(f.task, "first"), second = executionFor(f.task, "second");
      first.work.checkReturns = 1;
      f.task.activeProductId = "second";
      const before = JSON.stringify(f.task);
      expect(engine.activeState().tasks.find((task) => task.id === f.id)!.worktree).toBeUndefined();
      expect(engine.getState().tasks.find((task) => task.id === f.id)!.worktree).toBe(second.work.worktree);
      expect(engine.windowState().tasks.find((task) => task.id === f.id)!.report?.summary).toBe("second report");
      expect(engine.taskDetails(f.id)!.builderSession?.sessionId).toBe("second-conversation");
      expect(JSON.stringify(f.task)).toBe(before);
      first.work.report!.summary = "First finished while the second product was selected";
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.worktree).toBeUndefined();
      expect(saved.report).toBeUndefined();
      expect(saved.repositories!.map((work) => work.report!.summary)).toEqual([first.work.report!.summary, "second report"]);
      expect(() => executionFor(f.task, "outside")).toThrow("outside the approved task");
      await engine.shutdown();
      engine = f.start();
      const task = engine.task(f.id)!;
      expect(Object.hasOwn(task, "worktree")).toBe(false);
      expect(Object.hasOwn(task, "builderSession")).toBe(false);
      expect(task.repositories!.map((work) => work.builderSession!.sessionId)).toEqual(["first-conversation", "second-conversation"]);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([1, undefined]);
      expect(engine.taskDetails(f.id)!.branch).toBe("task-second");
    } finally { await engine.shutdown(); }
  });

  it("finishes a queued check against its bound owner after the task's current product changes", async () => {
    const { engine, task } = await fixture("queued-check");
    let release: (() => void) | undefined;
    let pending: Promise<number> | undefined;
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"];
      const signal = new AbortController().signal;
      release = await checks["turnToRun"](second, signal);
      pending = checks.runProductChecks(first, [{ name: "First product only", argv: [process.execPath, "-e", "console.error('Failure from the first product'); process.exit(1)"] }], signal);
      await waitFor(() => checks["line"].length === 1, "the first product's check to queue");
      task.activeProductId = "second";
      engine.getState(); engine.windowState(); engine.taskDetails(task.id); engine.commitNow();
      release(); release = undefined;
      expect(await pending).toBe(1);
      expect(first.work.checks!.results[0]!.output).toContain("Failure from the first product");
      expect(second.work.checks).toBeUndefined();
      expect(Object.hasOwn(task, "checks")).toBe(false);
      expect(task.findings.filter((finding) => finding.raisedBy === "petrina").map((finding) => finding.productIds)).toEqual([["first"]]);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).length).toBeGreaterThan(0);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).every((line) => line.productId === "first")).toBe(true);
      expect(engine.taskDetails(task.id)!.checks).toBeUndefined();
      engine.save();
      expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.repositories![0]!.checks!.results[0]!.ok).toBe(false);
    } finally { release?.(); await pending?.catch(() => {}); await engine.shutdown(); }
  });

  it("writes a shared reviewer's named lesson directly to its repository", async () => {
    const { engine, task } = await fixture("named-learning");
    try {
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const learnings = new Learnings(engine);
      await learnings.note(first, [{ productId: "second", text: "Use the second product's focused check for its UI changes." }], "code-reviewer", "sol-high");
      expect(first.work.lessons).toBeUndefined();
      expect(second.work.lessons?.map((lesson) => lesson.text)).toEqual(["Use the second product's focused check for its UI changes."]);
      expect(task.sharedLessons).toBeUndefined();
      expect(Object.hasOwn(task, "lessons")).toBe(false);
    } finally { await engine.shutdown(); }
  });

  it("keeps a single repository's saved execution separate from its public task view", async () => {
    const world = makeWorld("canonical-single"); worlds.push(world);
    const start = () => world.start({ agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
    let engine = start(); engine.setPoolPaused(true);
    try {
      const productId = await engine.addProduct(world.clone);
      const id = engine.addTask({ productId, title: "One canonical execution record", backlog: true });
      const task = engine.task(id)!;
      const { work } = executionFor(task);
      work.report = { summary: "Persisted only on the repository", changes: [] };
      work.checkReturns = 2;
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === id)!;
      expect(saved.report).toBeUndefined();
      expect(saved.repository!.report?.summary).toBe("Persisted only on the repository");
      expect(engine.taskDetails(id)!.repository).toBeUndefined();
      expect(engine.windowState().tasks.find((task) => task.id === id)!.report?.summary).toBe("Persisted only on the repository");
      await engine.shutdown(); engine = start();
      expect(Object.hasOwn(engine.task(id)!, "report")).toBe(false);
      expect(executionFor(engine.task(id)!).work.checkReturns).toBe(2);
      expect(engine.taskDetails(id)!.report?.summary).toBe("Persisted only on the repository");
    } finally { await engine.shutdown(); }
  });

  it("imports an existing saved cursor once without retaining another writable copy", async () => {
    const f = await fixture("saved-cursor");
    let engine = f.engine;
    try {
      f.task.activeProductId = "second";
      Object.assign(f.task, { branch: "latest-saved-second", report: { summary: "Latest second report from the previous engine", changes: [] } });
      engine.commitNow();
      await engine.shutdown();
      engine = f.start();
      const restored = engine.task(f.id)!;
      expect(Object.hasOwn(restored, "branch")).toBe(false);
      expect(Object.hasOwn(restored, "report")).toBe(false);
      expect(restored.repositories!.map((work) => work.branch)).toEqual(["task-first", "latest-saved-second"]);
      expect(restored.repositories![1]!.report!.summary).toBe("Latest second report from the previous engine");
      engine.save();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.branch).toBeUndefined();
      expect(saved.repositories![1]!.branch).toBe("latest-saved-second");
    } finally { await engine.shutdown(); }
  });
});
