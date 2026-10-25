import { afterAll, describe, expect, it } from "bun:test";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, lines, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviews that converge", () => {
it("never sends work back for a finding the fresh agent shows is not a bug", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "important", verifier: "not-a-bug" });

    const finding = task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!;
    expect(finding.status).toBe("dismissed");
    expect(finding.verification).toMatchObject({ verdict: "not-a-bug", reason: "The welcome page shows the greeting already." });
    expect(fakes.openings("builder")).toHaveLength(1);
    expect(lines(task).some((line) => line.startsWith("Sent back to the builder"))).toBe(false);
    expect(lines(task)).toContain("1 checked: none to fix now, 1 not a bug");
  });

});
