import { afterAll, describe, expect, it } from "bun:test";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviewers at once, then a vote", () => {
it("takes turns when the pool has one slot, and still gets every review and vote", async () => {
    const { task, fakes, atOnce, voters } = await untilDelivery({ reviewer: "important" }, 1);
    expect(atOnce).toBe(1);
    expect(fakes.openings("verifier")).toHaveLength(voters);
    expect(task.findings.find((finding) => finding.severity === "blocking" || finding.status === "fixed")?.verification).toMatchObject({ verdict: "real" });
  });

});
