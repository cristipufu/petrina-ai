import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Store } from "@petrina/storage/store";
import { reviewJourneyFixtures } from "../../fixtures/review.js";

const { untilDelivery, lines, close } = reviewJourneyFixtures();
afterAll(close);
describe.concurrent("reviews that converge", () => {
it("passes a fresh failing reproduction to the next builder and saves the original evidence in history", async () => {
    const evidence = "On current code, send an explicit dispute before an independent confirmation: the finding stays dismissed. Reverse the order: it stays open. Expected both orders to keep independently confirmed findings open.";
    const { task, fakes, root } = await untilDelivery({ builder: "plain", reviewer: "confirm-fixed", reviewRounds: 3, reopenedEvidence: evidence });
    const finding = task.findings.find((entry) => entry.severity === "blocking")!;
    expect(task.findings.filter((entry) => entry.id === finding.id)).toHaveLength(1);
    expect(task.findings.filter((entry) => entry.severity === "blocking")).toHaveLength(2);
    expect(finding.status).toBe("open");
    expect(finding.evidence).toBe(evidence);
    expect(finding.earlierReviews).toHaveLength(2);
    expect(finding.earlierReviews![0]!.evidence).toBe("Opened the welcome page");
    expect(finding.earlierReviews![1]!.evidence).toBe(evidence);
    const builders = fakes.openings("builder");
    expect(builders).toHaveLength(3);
    expect(builders[1]).toContain("Opened the welcome page");
    expect(builders[1]).not.toContain(evidence);
    expect(builders[2]).toContain(evidence);
    // Complete handoffs retain earlier proof, clearly labelled as historical rather than current support.
    expect(builders[2]).toContain("Earlier decisions below are historical, not current support.");
    expect(builders[2]).toContain("Opened the welcome page");
    expect(builders[2]!.indexOf(evidence)).toBeLessThan(builders[2]!.indexOf("Opened the welcome page"));
    const original = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!.result!.findings!.find((entry) => entry.id === finding.id)!;
    expect(original.evidence).toBe("Opened the welcome page");
    const store = new Store(join(root, "data", "petrina.db"));
    try {
      const saved = store.load()!.tasks.find((entry) => entry.id === task.id)!.findings.find((entry) => entry.id === finding.id)!;
      expect(saved.evidence).toBe(evidence);
      expect(saved.earlierReviews![0]!.evidence).toBe("Opened the welcome page");
    } finally { store.close(); }
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
  });




});
