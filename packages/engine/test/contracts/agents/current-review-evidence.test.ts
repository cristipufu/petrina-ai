import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { afterAll, describe, expect, it } from "bun:test";
import type { Scenario } from "../../fake-agent.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
import { contextStageFixtures } from "../../fixtures/context-stage.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { untilDelivery, lines } = reviewJourneyFixtures();
const prepared = contextStageFixtures();
afterAll(() => prepared.close());
describe.concurrent("reviews that converge", () => {
  for (const [name, scenario, role, corrections] of [
    ["single code review", { planner: "short", reviewRounds: 2 }, "code reviewer", 1],
    ["resumed parallel code review after screen permission", { screenRoles: ["code reviewer"] }, "code reviewer", 2],
  ] as [string, Scenario, string, number][]) {
    it(`requires current reopening evidence in ${name}, then accepts a correction in the same conversation`, async () => {
      return cases.use("petrina-engine-case-", async owner => {
        const input: Scenario = { ...scenario, builder: "plain", reviewer: "important", reviewConfirmation: { role, correction: "omit" } };
        const { task, fakes } = await (scenario.screenRoles ? untilDelivery(owner, input, undefined, false, { entry: "builder", skipDiffs: true }) : prepared.evidence(input));
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
    });
  }

});
