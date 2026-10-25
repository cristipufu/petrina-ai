import { afterAll, describe, expect, it } from "bun:test";
import { git } from "../../fixtures.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, close } = reviewJourneyFixtures();
afterAll(close);
describe("a clean history", () => {
it("ships the task as one commit on top of main, however many commits its branch had", async () => {
    const { task, repo, before } = await untilDelivery({ reviewer: "important", fixes: "change" }, undefined, true);
    // A build and a round of review fixes, kept as one commit all along.
    expect(task.timeline.map((entry) => entry.text)).toContain("Sent back to the builder: 1 important");
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
    expect(await git(repo, "log", "-1", "--format=%B", "main")).toContain("Built by Petrina");
  });

});
