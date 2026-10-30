import { completeAll } from "@petrina/core";
import { describe, expect, it, spyOn } from "bun:test";
import * as steps from "@petrina/repositories/git";
import { withReviewSettlement } from "../../fixtures/review-settlement.js";

describe("shared review settlement interleavings", () => {
  for (const active of ["first", "second"]) for (const security of [false, true]) it(`keeps repository anchors through state reads while a ${security ? "security" : "code"} round closes with ${active} active`, async () => {
    await withReviewSettlement(async ({ first, second, engine, task, stage, run }) => {
      task.activeProductId = active;
      stage.roleId = security ? "security-reviewer" : "code-reviewer";
      const readVersion = steps.commitVersion, readTree = steps.treeOf;
      const heads = await completeAll([first, second].map(async (world) => (await steps.head(world.clone))!));
      const trees = await completeAll([first, second].map(async (world) => (await steps.treeOf(world.clone))!));
      expect(heads[0]).not.toBe(heads[1]);
      expect(trees[0]).not.toBe(trees[1]);
      const version = spyOn(steps, "commitVersion");
      try {
        version.mockImplementation(async (path) => { const result = await readVersion(path); engine.activeState(); return result; });

        const tree = spyOn(steps, "treeOf");
        try {
          tree.mockImplementation(async (...args) => { const result = await readTree(...args); engine.activeState(); return result; });

          await run(() => engine["reviews"]["closeReviewRound"](task, stage, 1, "Nothing to fix"));
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

        } finally { tree.mockRestore(); }
      } finally { version.mockRestore(); }
    });
  });

  it("preserves the existing code-review anchors when a single-product security round passes", async () => {
    await withReviewSettlement(async ({ engine, task, stage, run }) => {
      const owner = task.repositories![0]!;
      delete task.repositories;
      task.repository = owner;
      stage.roleId = "security-reviewer";
      const before = { tree: owner.reviewedTree, sha: owner.reviewedSha };
      const version = spyOn(steps, "commitVersion");
      try {
        const tree = spyOn(steps, "treeOf");
        try {

          await run(() => engine["reviews"]["closeReviewRound"](task, stage, 1, "No security findings"));
          expect({ tree: owner.reviewedTree, sha: owner.reviewedSha }).toEqual(before);
          expect(version).not.toHaveBeenCalled();
          expect(tree).not.toHaveBeenCalled();

        } finally { tree.mockRestore(); }
      } finally { version.mockRestore(); }
    });
  });

});
