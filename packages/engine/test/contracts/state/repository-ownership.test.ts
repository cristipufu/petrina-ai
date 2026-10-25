import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("schedules a renamed tester's final pass once and reuses the verified version at delivery", async () => {
    const { engine, task } = await fixture("custom-final-tester", { git: ["first"] });
    const repository = task.repositories![0]!;
    delete task.repositories;
    task.repository = repository;
    const tester = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist" };
    engine.s.roles.push(tester);
    task.plan = { rationale: "Test final code", plannerProfileId: "sol-high", stages: [
      { id: "test", title: "Acceptance", kind: "do", roleId: tester.id, profileIds: ["sol-high"] },
      { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    ] };
    task.stageIndex = 0;
    task.testedPatch = "earlier-version";
    task.acceptancePassed = true;
    task.state = "running";
    engine.s.pool.paused = false;
    engine.draining = false;
    const updated = spyOn(engine["updates"], "upToDate").mockResolvedValue("current");
    const checks = spyOn(engine["checks"], "checksBeforeDelivery").mockResolvedValue("passed");
    const version = spyOn(engine["checks"], "acceptanceVersion").mockResolvedValue("final-version");
    const reserve = engine["driver"].workflow["reserveAgent"];
    engine["driver"].workflow["reserveAgent"] = () => true;
    const work = spyOn(engine["work"], "runDo").mockImplementation(async (_scope, stage) => {
      expect(stage.roleId).toBe(tester.id);
      expect(task.retest).toBe(true);
      task.testedPatch = "final-version";
      delete task.retest;
      task.stageIndex = 1;
      return "continue";
    });
    try {
      await engine["driver"].workflow["drive"](task.id, true);
      expect(task.error).toBeUndefined();
      expect(engine.taskDetails(task.id)!.state).toBe("needs-you");
      expect(work).toHaveBeenCalledTimes(1);
      expect(engine.s.inbox.some(item => item.taskId === task.id && item.kind === "delivery")).toBe(true);
    } finally { work.mockRestore(); engine["driver"].workflow["reserveAgent"] = reserve; version.mockRestore(); checks.mockRestore(); updated.mockRestore(); await engine.shutdown(); }
  });

  it("persists cached archive edits before eviction and keeps live projections light with independent revisions", async () => {
    const { engine, task } = await fixture("projection-eviction");
    const ids = Array.from({ length: 20 }, (_, index) => engine.addTask({ productId: "first", title: `Archive ${index}`, backlog: true }));
    for (const id of ids) engine.cancel(id);
    engine.save();
    const first = engine.task(ids[0]!)!;
    first.statusLine = "Updated while archived";
    engine.commit(first);
    for (const id of ids.slice(1)) expect(engine.taskDetails(id)).toBeDefined();
    const reopened = engine.task(ids[0]!)!;
    expect(reopened).not.toBe(first);
    expect(reopened.statusLine).toBe("Updated while archived");
    task.session = [{ id: "large", at: 1, from: "agent", text: "Conversation ".repeat(1000) }];
    const all = spyOn(engine.store.history, "all").mockImplementation(() => { throw new Error("Live projection must not load archive bodies"); });
    try {
      const before = engine.windowState().tasks.find(entry => entry.id === task.id)!;
      task.todo = "A new to-do item"; engine.commit(task);
      const after = engine.windowState().tasks.find(entry => entry.id === task.id)!;
      expect(after.detailsRevision).not.toBe(before.detailsRevision);
      expect(after.session).toEqual([]);
      expect(engine.taskDetails(task.id)!.session).toHaveLength(1);
      expect(engine.historyPage({}).total).toBe(20);
      expect(all).not.toHaveBeenCalled();
    } finally { all.mockRestore(); await engine.shutdown(); }
  });

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

  it("keeps a single repository's saved execution separate from its public task view", async () => {
    const saved = await fixture("canonical-single");
    const { start } = saved;
    let engine = saved.engine;
    try {
      const productId = "first";
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
