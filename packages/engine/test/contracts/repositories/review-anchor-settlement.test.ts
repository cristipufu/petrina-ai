import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as steps from "@petrina/repositories/git";
import { git } from "../../support.js";
import { reviewSettlementFixtures } from "../../fixtures/review-settlement.js";

const { fixture, close } = reviewSettlementFixtures();
afterAll(close);
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

});
