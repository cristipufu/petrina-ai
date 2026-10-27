import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { git } from "../../fixtures.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { untilDelivery } = reviewJourneyFixtures();
describe("a clean history", () => {
  it("ships the task as one commit on top of main, however many commits its branch had", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { task, repo, before } = await untilDelivery(owner, { reviewer: "important", fixes: "change" }, undefined, true);
      // A build and a round of review fixes, kept as one commit all along.
      expect(task.timeline.map((entry) => entry.text)).toContain("Sent back to the builder: 1 important");
      expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
      expect(await git(repo, "log", "-1", "--format=%B", "main")).toContain("Built by Petrina");

    });
  });

});
