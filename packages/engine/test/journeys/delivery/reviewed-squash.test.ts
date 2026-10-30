import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
import { readLooseCommit, readRef } from "../../fixtures/shared-preparation.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { untilDelivery } = reviewJourneyFixtures();
describe("a clean history", () => {
  it("ships the task as one commit on top of main, however many commits its branch had", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const { task, repo, before } = await untilDelivery(owner, { reviewer: "important", fixes: "change" }, undefined, true, { entry: "builder", skipDiffs: true });
      // A build and a round of review fixes, kept as one commit all along.
      expect(task.timeline.map((entry) => entry.text)).toContain("Sent back to the builder: 1 important");
      const tip = readLooseCommit(join(repo, ".git"), readRef(join(repo, ".git"), "refs/heads/main")!)!;
      expect(tip.parents).toEqual([before]);
      expect(tip.body.split(/\r?\n/)[0]).toBe("Add a greeting");
      expect(tip.body).toContain("Built by Petrina");

    });
  });

});
