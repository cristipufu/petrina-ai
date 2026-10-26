import { expectRejection } from "@petrina/test-support/rejections";
import { describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as steps from "@petrina/repositories/git";
import { withReviewSettlement } from "../../fixtures/review-settlement.js";

describe("shared review settlement interleavings", () => {
  for (const workFails of [false, true]) it(`keeps ${workFails ? "the original review failure" : "the saved review"} when removing a secondary snapshot fails`, async () => {
    await withReviewSettlement(async ({ second, engine, task, run }) => {
      const remove = steps.removeCopies;
      let failedCleanup = false, reported = false, started = false;
      const cleanup = spyOn(steps, "removeCopies");
      try {
        cleanup.mockImplementation(async (root, path, kept) => {
          if (started && !failedCleanup && root === second.clone) { failedCleanup = true; throw new Error("the product's repository could not be read"); }
          return remove(root, path, kept);
        });

        engine.draining = false;
        engine.s.pool.paused = false;
        task.holdsSlot = true;
        const review = () => engine["reviews"]["together"](task, [{ key: "review-0", reviewKey: "reviewer:0", roleId: "code-reviewer", profileId: "sol-high", work: async () => {
              started = true;
              if (workFails) throw new Error("The review failed before handing back a result");
              reported = true;
              task.hunt!.reported = { "0": true };
              engine.commitNow();
        } }], engine.stopRequested.signal, () => "Reviewing");
        if (workFails) await run(() => expectRejection(review(), "The review failed before handing back a result"));
        else await run(review);
        expect(failedCleanup).toBe(true);
        expect(reported).toBe(!workFails);
        expect(task.timeline.some((line) => line.text.includes("review copy") && line.text.includes("could not be read"))).toBe(true);
        expect(existsSync(join(engine.dataDir, "worktrees", "first", `${task.id}.copies`))).toBe(false);
        // Failed disposable-copy cleanup is left for the next sweep, without losing
        // either the result or the original error. A later cleanup can reclaim it.
        await steps.removeCopies(second.clone, join(engine.dataDir, "worktrees", "second", `${task.id}.copies`));
        expect(await steps.linkedWorktrees(second.clone)).toEqual([]);

      } finally { cleanup.mockRestore(); }
    });
  });

});
