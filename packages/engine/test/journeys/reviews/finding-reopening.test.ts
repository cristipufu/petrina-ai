import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { reviewStats } from "@petrina/core";
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

it("keeps new reports separate from earlier fixed findings even when their wording repeats", async () => {
    const { task, fakes } = await untilDelivery({ builder: "plain", reviewer: "important-twice", reviewRounds: 3, reviewConfirmation: { role: "code reviewer", correction: "evidence", duplicate: true } });
    const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer" && step.endedAt !== undefined).length;
    expect(rounds).toBeGreaterThanOrEqual(3);
    expect(task.findings).toHaveLength(rounds * 2);
    expect(new Set(task.findings.map((finding) => finding.id)).size).toBe(rounds * 2);
    expect(task.findings.filter((finding) => finding.status === "fixed")).toHaveLength((rounds - 1) * 2);
    expect(task.findings.filter((finding) => finding.status === "open")).toHaveLength(2);
    expect(task.findings.every((finding) => !finding.earlierReviews?.length && !finding.confirmedBy.length)).toBe(true);
    expect(fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"))).toHaveLength(0);
    const builders = fakes.openings("builder");
    expect(builders).toHaveLength(rounds);
    for (const finding of task.findings.slice(2, 4)) expect(builders[2]).toContain(`[${finding.id}]`);
    expect(builders[2]).toContain("fix it once");
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
  });

it("keeps a previously real, builder-fixed finding fixed when fresh voters reject a false reopening", async () => {
    const { task, fakes, voters, nonblocking } = await untilDelivery({ reviewer: "confirm-fixed-one-tool", verifier: "after-fix-not-a-bug" });
    const finding = task.findings.find((entry) => entry.severity === "blocking")!;
    expect(finding.answer?.fixed).toBe(true);
    expect(finding.status).toBe("fixed");
    expect(finding.verification?.verdict).toBe("not-a-bug");
    expect(finding.votes?.map((vote) => vote.verdict)).toEqual(Array(nonblocking).fill("not-a-bug"));
    expect(finding.earlierReviews).toHaveLength(1);
    expect(finding.earlierReviews![0]!.verification?.verdict).toBe("real");
    expect(finding.earlierReviews![0]!.votes?.map((vote) => vote.verdict)).toEqual(Array(voters).fill("real"));
    expect(reviewStats([task]).findings).toMatchObject({ fixed: 1, notABug: 0 });
    expect(fakes.openings("verifier")).toHaveLength(voters + nonblocking);
    expect(fakes.openings("builder")).toHaveLength(2);
  });

it("keeps a finding open when reviewers confirm that the claimed fix is still broken", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "confirm-fixed" });
    const finding = task.findings.find((entry) => entry.text.toLowerCase().replace(/!$/, ".") === "the greeting is missing on the welcome page.")!;
    expect(finding.answer?.fixed).toBe(true);
    expect(finding.status).toBe("open");
    expect(task.findings.filter((entry) => entry.text === finding.text)).toHaveLength(1);
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
    expect(fakes.openings("builder").length).toBeLessThanOrEqual(3);
  });

});
