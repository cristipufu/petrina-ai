import { afterAll, describe, expect, it } from "bun:test";
import type { Scenario } from "../../fake-agent.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, lines, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviews that converge", () => {
for (const [name, scenario, role, corrections] of [
    ["single code review", { planner: "short", reviewRounds: 2 }, "code reviewer", 1],
    ["parallel code review", {}, "code reviewer", 2],
    ["resumed parallel code review after screen permission", { screenRoles: ["code reviewer"] }, "code reviewer", 2],
    ["security review", { risk: "high" }, "security reviewer", 1],
    ["added findings role", { planner: "mixed-review" }, "security specialist", 1],
  ] as [string, Scenario, string, number][]) {
    it(`requires current reopening evidence in ${name}, then accepts a correction in the same conversation`, async () => {
      const { task, fakes } = await untilDelivery({ ...scenario, builder: "plain", reviewer: "important", reviewConfirmation: { role, correction: "omit" } });
      const findings = task.findings.filter((finding) => finding.severity === "blocking");
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.status).toBe("fixed");
        expect(finding.answer?.fixed).toBe(true);
        expect(finding.earlierReviews).toBeUndefined();
      }
      const correctionsSent = fakes.received(role).filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"));
      expect(correctionsSent).toHaveLength(corrections);
      for (const correction of correctionsSent) {
        const opening = fakes.received(role).find((entry) => entry.session === correction.session)!;
        expect(opening.text).toContain("(fixed)");
        expect(opening.text).toContain(findings[0]!.id);
      }
      expect(fakes.openings("builder")).toHaveLength(2);
      expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(false);
    });
  }

});
