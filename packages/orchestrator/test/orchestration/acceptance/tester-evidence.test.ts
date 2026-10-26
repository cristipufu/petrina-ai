import { expect, it } from "vitest";
import { journeyProblems } from "@petrina/core";
import { requiredAcceptanceFixture, failing } from "../../fixtures/required-acceptance.js";

for (const changes of [false, true]) it(`bounds failing acceptance with changed code ${changes}, keeps one finding, and resets the allowance only for your change request`, async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.configure({ checks: [failing()], changeOnRepair: changes });
    f.task.approveDelivery = true;
    f.task.plan!.stages.splice(3, 0, { id: "planned-check", kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "coordinator", profileIds: [] });
    await f.drive();
    expect(f.task.acceptancePassed).toBe(false);
    expect(f.scope.work.acceptanceReturns).toBe(2);
    expect(f.agents.received("checks")).toHaveLength(4);
    const findings = f.task.findings.filter(finding => finding.text.startsWith("Failed acceptance check"));
    expect(findings).toHaveLength(1); expect(findings[0]!.status).toBe("open");
    const testerSteps = f.task.journey!.filter(step => step.roleId === "tester");
    expect(testerSteps).toHaveLength(4);
    const failedChecks = testerSteps.flatMap(step => step.acceptanceChecks ?? []).filter(check => check.result === "fail");
    expect(failedChecks).toHaveLength(4); expect(new Set(failedChecks.map(check => check.text)).size).toBe(1);
    expect(journeyProblems(f.task)).toEqual([]);
    // A modeled snapshot is not a SQL restart: the retained changed-code native row proves durable reopening.
    const recorded = structuredClone({ returns: f.scope.work.acceptanceReturns, findings: f.task.findings, decision: f.decisions()[0] });
    expect(recorded.returns).toBe(2); expect(recorded.decision).toBeDefined();
    f.requestChanges("Try another approach to make the greeting visible");
    expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { await f.close(); }
});

for (const tester of ["blocked", "no-evidence"] as const) it(`keeps ${tester} acceptance checks unverified and prevents an unchanged retry or low-risk auto-ship`, async () => {
  const f = requiredAcceptanceFixture();
  try {
    const reason = tester === "blocked" ? "The Claude Code weekly limit prevents opening a live session." : "The agent did not record how it verified this item.";
    f.configure({ checks: [{ text: "People see the greeting on the welcome page", result: tester === "blocked" ? "blocked" : "pass", ...(tester === "blocked" ? { reason } : {}) }] });
    f.product.shipLowRisk = true; f.product.approveDelivery = true; f.task.approveDelivery = true;
    f.task.risk = { level: "low", why: "Only a greeting file changes." };
    f.task.plan!.stages.splice(3, 0, { id: "planned-check", kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "coordinator", profileIds: [] });
    await f.drive();
    expect(f.task.state).toBe("needs-you"); expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.brief!.acceptance[0]).toMatchObject({ verification: "blocked", reason });
    expect(f.task.findings.filter(finding => finding.status === "open" && finding.severity === "blocking")).toHaveLength(0);
    expect(f.decisions()[0]!.title).toContain("1 acceptance check could not be verified");
    expect(f.agents.received("checks")).toHaveLength(1); expect(f.runs()).toHaveLength(1); expect(f.scope.work.landed).toBeUndefined();
    expect(f.delivery.published).toEqual([]);
    await f.drive();
    expect(f.agents.received("checks")).toHaveLength(1); expect(f.delivery.published).toEqual([]);
  } finally { await f.close(); }
});
