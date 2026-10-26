import { expect, it } from "vitest";
import { MAX_REVIEW_ROUNDS } from "@petrina/core";
import { findingRepairFixture } from "../../fixtures/finding-repairs.js";

it("keeps new reports separate from earlier fixed findings even when their wording repeats", async () => {
  const f = findingRepairFixture("new-reports");
  try {
    const task = await f.run();
    const rounds = task.journey!.filter(step => step.roleId === "code-reviewer" && step.endedAt !== undefined).length;
    expect(rounds).toBeGreaterThanOrEqual(3);
    expect(task.findings).toHaveLength(rounds * 2);
    expect(new Set(task.findings.map(finding => finding.id)).size).toBe(rounds * 2);
    expect(task.findings.filter(finding => finding.status === "fixed")).toHaveLength((rounds - 1) * 2);
    expect(task.findings.filter(finding => finding.status === "open")).toHaveLength(2);
    expect(task.findings.every(finding => !finding.earlierReviews?.length && !finding.confirmedBy.length)).toBe(true);
    // These are actual evidence-validator results, not an empty log from a fixture that never emits corrections.
    expect(f.reviewInputs.every(input => input.error === undefined)).toBe(true);
    // Actual AgentWorkflow do-stage dispatches; F01/F03 retain physical ACP-start assertions.
    expect(f.builderDispatches).toHaveLength(rounds);
    expect(f.notes.some(line => line.startsWith("Review rounds used up"))).toBe(true);
    expect(rounds).toBe(MAX_REVIEW_ROUNDS);
  } finally { await f.close(); }
});

it("keeps a finding open when reviewers confirm that the claimed fix is still broken", async () => {
  const f = findingRepairFixture("confirmation");
  try {
    const task = await f.run();
    const finding = task.findings.find(entry => entry.text.toLowerCase().replace(/!$/, ".") === "the greeting is missing on the welcome page.")!;
    expect(finding.answer?.fixed).toBe(true);
    expect(finding.status).toBe("open");
    expect(task.findings.filter(entry => entry.text === finding.text)).toHaveLength(1);
    expect(f.notes.some(line => line.startsWith("Review rounds used up"))).toBe(true);
    // This bounds actual AgentWorkflow dispatches, not native process starts.
    expect(f.builderDispatches.length).toBeLessThanOrEqual(3);
  } finally { await f.close(); }
});
