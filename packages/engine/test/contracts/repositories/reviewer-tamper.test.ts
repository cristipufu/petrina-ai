import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { untilDelivery, lines } = reviewJourneyFixtures();
describe.concurrent("reviewers at once, then a vote", () => {
  it("puts the task's branch back when a reviewer moves it from its own copy", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { task, fakes } = await untilDelivery(owner, { reviewer: "move-branch" }, undefined, false, { entry: "builder", skipDiffs: true });
      expect(fakes.marked("branch-moved")).toBe(true);
      expect(lines(task)).toContain("Undid commits from Code reviewer, which is read-only");
      // The work the builder committed is still what ships.
      expect(readWorktreeCommit(task.worktree!)?.body.split(/\r?\n/)[0]).toBe("Add a greeting");

    });
  });

});
