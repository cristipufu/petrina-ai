import { expect, it } from "vitest";
import { executionFor } from "../../../src/repository-context.js";
import { sourcePlanAdmission } from "../../fixtures/source-plan-admission.js";

for (const approvePlan of [undefined, false]) it(`requires source confirmation when the planner chooses the product, with optional plan approval ${approvePlan === false ? "off" : "defaulted"}`, async () => {
  const f = sourcePlanAdmission({ productId: "", title: "Fix it", approvePlan }, [{ productId: "shop", startFrom: { kind: "default" }, delivery: "local" }]);
  try {
    await f.drive();
    expect(f.scheduler.failures).toEqual([]);
    expect(f.task.productId).toBe(""); expect(executionFor(f.task).work.worktree).toBeUndefined();
    expect(f.gates).toEqual(["plan"]); expect(f.stages).toEqual([]); expect(f.preparation).toEqual([undefined]);
    expect(f.source.calls).toEqual(["valid:main"]);
    f.source.selections.confirm(f.task);
    expect(f.task.productId).toBe("shop");
    expect(executionFor(f.task).work.source?.confirmed).toBe(true);
    expect(executionFor(f.task).work.worktree).toBeUndefined();
  } finally { await f.close(); }
});

it("keeps ordinary default tasks able to skip the plan check, without interpreting PR words", async () => {
  const f = sourcePlanAdmission({ productId: "shop", title: "Fix PR #999 on release-2.x", delivery: "local", approvePlan: false });
  try {
    await f.drive();
    expect(f.scheduler.failures).toEqual([]); expect(f.task.error).toBeUndefined();
    expect(executionFor(f.task).work.source?.start).toEqual({ kind: "default", branch: "main" });
    expect(f.gates).toEqual([]); expect(f.stages).toEqual(["builder"]);
    expect(f.source.calls).toEqual(["valid:main"]);
    expect(f.task.timeline.some(entry => entry.text === "You approved the plan")).toBe(false);
  } finally { await f.close(); }
});
