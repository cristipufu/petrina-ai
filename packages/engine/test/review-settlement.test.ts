import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as steps from "@petrina/repositories/git";
import { git, makeWorld, removeDir, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach((world) => removeDir(world.dir)));
async function fixture() {
  const first = await makeWorld("review-settle-first"), second = await makeWorld("review-settle-second");
  worlds.push(first, second);
  writeFileSync(join(second.clone, "SECOND.md"), "Only the second repository has this file.\n");
  await git(second.clone, "add", "SECOND.md");
  await git(second.clone, "commit", "-q", "-m", "Give the second repository distinct review evidence");
  const engine = first.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const products = [first, second].map((world, index) => ({ id: index ? "second" : "first", name: index ? "Second" : "First", repo: index ? "acme/second" : "acme/first", path: world.clone, tone: "blue" as const, delivery: "local" as const }));
  engine.s.products.push(...products);
  const id = engine.addTask({ productId: "first", worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "local" })), title: "Keep completed review evidence", backlog: true });
  const task = engine.task(id)!;
  task.repositories = products.map((product) => ({ productId: product.id, source: { product, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true }, worktree: product.path, delivery: "local", completedStages: [], reviewedSha: `earlier-${product.id}`, reviewedTree: `earlier-tree-${product.id}` }));
  task.activeProductId = "first";
  const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
  task.plan = { rationale: "Review both", plannerProfileId: "sol-high", stages: [stage, { id: "delivery", title: "Delivery", kind: "gate", roleId: "release-manager", profileIds: [], gate: "delivery" }] };
  task.stageIndex = 0;
  task.state = "running";
  task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 0 };
  return { first, second, engine, task, stage };
}

describe("shared review settlement interleavings", () => {
  for (const active of ["first", "second"]) for (const security of [false, true]) it(`keeps repository anchors through state reads while a ${security ? "security" : "code"} round closes with ${active} active`, async () => {
    const { first, second, engine, task, stage } = await fixture();
    task.activeProductId = active;
    stage.roleId = security ? "security-reviewer" : "code-reviewer";
    const readVersion = steps.commitVersion, readTree = steps.treeOf;
    const heads = await Promise.all([first, second].map((world) => git(world.clone, "rev-parse", "HEAD")));
    const trees = await Promise.all([first, second].map((world) => git(world.clone, "rev-parse", "HEAD^{tree}")));
    expect(heads[0]).not.toBe(heads[1]);
    expect(trees[0]).not.toBe(trees[1]);
    const version = spyOn(steps, "commitVersion").mockImplementation(async (path) => { const result = await readVersion(path); engine.activeState(); return result; });
    const tree = spyOn(steps, "treeOf").mockImplementation(async (...args) => { const result = await readTree(...args); engine.activeState(); return result; });
    try {
      await engine["reviews"]["closeReviewRound"](task, stage, 1, "Nothing to fix");
      expect(version).toHaveBeenCalledTimes(security ? 0 : 2);
      expect(tree).toHaveBeenCalledTimes(security ? 2 : 0);
      expect(task.repositories!.map((work) => work.reviewedSha)).toEqual(security ? ["earlier-first", "earlier-second"] : heads);
      expect(task.repositories!.map((work) => work.reviewedTree)).toEqual(trees);
      const activeIndex = active === "first" ? 0 : 1;
      expect(engine.taskDetails(task.id)!.reviewedSha).toBe(security ? `earlier-${active}` : heads[activeIndex]);
      expect(engine.taskDetails(task.id)!.reviewedTree).toBe(trees[activeIndex]);
      engine.save();
      const saved = engine.store.load()!.tasks.find((entry) => entry.id === task.id)!;
      expect(saved.repositories!.map((work) => work.reviewedSha)).toEqual(security ? ["earlier-first", "earlier-second"] : heads);
      expect(saved.repositories!.map((work) => work.reviewedTree)).toEqual(trees);
      expect(saved.reviewedTree).toBeUndefined();
    } finally { version.mockRestore(); tree.mockRestore(); await engine.shutdown(); }
  });

  it("preserves the existing code-review anchors when a single-product security round passes", async () => {
    const { engine, task, stage } = await fixture();
    const owner = task.repositories![0]!;
    delete task.repositories;
    task.repository = owner;
    stage.roleId = "security-reviewer";
    const before = { tree: owner.reviewedTree, sha: owner.reviewedSha };
    const version = spyOn(steps, "commitVersion"), tree = spyOn(steps, "treeOf");
    try {
      await engine["reviews"]["closeReviewRound"](task, stage, 1, "No security findings");
      expect({ tree: owner.reviewedTree, sha: owner.reviewedSha }).toEqual(before);
      expect(version).not.toHaveBeenCalled();
      expect(tree).not.toHaveBeenCalled();
    } finally { version.mockRestore(); tree.mockRestore(); await engine.shutdown(); }
  });

  for (const workFails of [false, true]) it(`keeps ${workFails ? "the original review failure" : "the saved review"} when removing a secondary snapshot fails`, async () => {
    const { second, engine, task } = await fixture();
    const remove = steps.removeCopies;
    let failedCleanup = false, reported = false, started = false;
    const cleanup = spyOn(steps, "removeCopies").mockImplementation(async (root, path, kept) => {
      if (started && !failedCleanup && root === second.clone) { failedCleanup = true; throw new Error("the product's repository could not be read"); }
      return remove(root, path, kept);
    });
    try {
      engine.draining = false;
      engine.s.pool.paused = false;
      task.holdsSlot = true;
      const together = engine["reviews"]["together"](task, [{ key: "review-0", reviewKey: "reviewer:0", roleId: "code-reviewer", profileId: "sol-high", work: async () => {
        started = true;
        if (workFails) throw new Error("The review failed before handing back a result");
        reported = true;
        task.hunt!.reported = { "0": true };
        engine.commitNow();
      } }], new AbortController().signal, () => "Reviewing");
      if (workFails) await expectRejection(together, "The review failed before handing back a result");
      else await together;
      expect(failedCleanup).toBe(true);
      expect(reported).toBe(!workFails);
      expect(task.timeline.some((line) => line.text.includes("review copy") && line.text.includes("could not be read"))).toBe(true);
      expect(existsSync(join(engine.dataDir, "worktrees", "first", `${task.id}.copies`))).toBe(false);
      // Failed disposable-copy cleanup is left for the next sweep, without losing
      // either the result or the original error. A later cleanup can reclaim it.
      await steps.removeCopies(second.clone, join(engine.dataDir, "worktrees", "second", `${task.id}.copies`));
      expect(await steps.linkedWorktrees(second.clone)).toEqual([]);
    } finally { cleanup.mockRestore(); await engine.shutdown(); }
  });
});
