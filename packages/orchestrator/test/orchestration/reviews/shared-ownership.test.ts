import { expect, it } from "vitest";
import { findingRepairFixture } from "../../fixtures/finding-repairs.js";

it("keeps unassigned Important findings under Together and sends them to no builder", async () => {
  const f = findingRepairFixture("shared-ownership");
  try {
    const task = await f.run();
    expect(task.findings.some(finding => finding.severity === "blocking" && finding.status === "open" && !finding.productIds?.length)).toBe(true);
    expect(f.builderDispatches).toHaveLength(0);
    expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
    expect(task.reviewDecision?.accepted).toBe(false);
    // The native unassigned-world pair proves the two distinct approvals and both actual PR creations.
  } finally { await f.close(); }
});

it("repairs assigned review problems while leaving unassigned problems for the coordinator", async () => {
  const f = findingRepairFixture("shared-ownership", true);
  try {
    const task = await f.run();
    expect(f.builderDispatches).toHaveLength(1);
    expect(f.builderDispatches[0]!.productId).toBe("second");
    const assigned = task.findings.filter(finding => finding.severity === "blocking" && finding.productIds?.length);
    expect(assigned).toHaveLength(2);
    expect(assigned.every(finding => finding.status === "fixed" && finding.answers?.second?.fixed)).toBe(true);
    expect(task.findings.find(finding => finding.text.includes("ownership needs"))?.status).toBe("open");
    expect(f.builderDispatches[0]!.findings.map(finding => finding.id)).toEqual(assigned.map(finding => finding.id));
    expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery"); expect(task.reviewDecision?.accepted).toBe(false);
  } finally { await f.close(); }
});
