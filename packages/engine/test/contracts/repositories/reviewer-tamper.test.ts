import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { git } from "../../fixtures.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { untilDelivery, lines } = reviewJourneyFixtures();
describe.concurrent("reviewers at once, then a vote", () => {
  it("puts the task's branch back when a reviewer moves it from its own copy", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { task, fakes } = await untilDelivery(owner, { reviewer: "move-branch" });
      expect(fakes.marked("branch-moved")).toBe(true);
      expect(lines(task)).toContain("Undid commits from Code reviewer, which is read-only");
      // The work the builder committed is still what ships.
      expect(await git(task.worktree!, "log", "-1", "--format=%s")).toBe("Add a greeting");

    });
  });

});
