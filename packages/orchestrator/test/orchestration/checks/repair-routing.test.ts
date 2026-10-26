import { expect, it } from "vitest";
import { checkRepairs, observedCheck } from "../../fixtures/check-repairs.js";
import { executionFor } from "../../../src/repository-context.js";

for (const shared of [false, true]) {
  it("bounds actual check returns independently of review rounds (shared: " + shared + ")", () => {
    const f = checkRepairs(shared), work = f.scope.work;
    f.controller.recordFailedFindings(f.scope, [observedCheck()]);
    f.task.rounds.review = 2; f.task.blockingAfter = { review: [1] };
    for (const count of [1, 2]) {
      f.task.stageIndex = 2; f.task.sub = 3;
      Object.assign(work, { approvedSha: "old", approvedPatch: "old", approvedFor: { by: "coordinator", mode: work.delivery, destination: "main" } });
      expect(f.controller.backToBuilder(f.scope, "before review", new Set([work.productId]))).toBe(true);
      expect(work.checkReturns).toBe(count);
      expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.sub).toBe(0);
      if (!shared) expect([work.approvedSha, work.approvedPatch, work.approvedFor]).toEqual([undefined, undefined, undefined]);
    }
    f.task.stageIndex = 2;
    const snapshot = structuredClone(f.task);
    expect(f.controller.backToBuilder(f.scope, "before review", new Set([work.productId]))).toBe(false);
    expect(f.task).toEqual(snapshot);
    expect(f.task.rounds).toEqual({ review: 2 }); expect(f.task.blockingAfter).toEqual({ review: [1] });
    expect(f.calls).toEqual(shared ? ["checkpoint", "checkpoint"] : ["changed", "changed"]);
    expect(f.checkpoints).toHaveLength(shared ? 2 : 0);
  });

  it.each(["empty eligibility", "no builder", "exhausted"])("leaves an ineligible repair untouched: %s (shared: " + shared + ")", kind => {
    const f = checkRepairs(shared); f.controller.recordFailedFindings(f.scope, [observedCheck()]);
    if (kind === "no builder") f.task.plan!.stages[0]!.roleId = "tester";
    if (kind === "exhausted") f.scope.work.checkReturns = 2;
    const snapshot = structuredClone(f.task);
    expect(f.controller.backToBuilder(f.scope, "before review", new Set(kind === "empty eligibility" ? [] : [f.scope.work.productId]))).toBe(false);
    expect(f.task).toEqual(snapshot); expect(f.calls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });

  it.each(["checks", "setup"])("refuses an automatic repair while %s process ownership is unconfirmed (shared: " + shared + ")", kind => {
    const f = checkRepairs(shared), run = observedCheck();
    f.controller.recordFailedFindings(f.scope, [run]);
    run.execution!.cleanup = "unconfirmed";
    if (kind === "checks") f.scope.work.checks = { at: 1, results: [run] };
    else {
      f.scope.work.checkSetup = { id: "setup", productId: f.scope.work.productId, position: "before-checks", queuedAt: 0,
        input: { contract: "declared", definition: "checks" }, requirements: [], lifecycle: "settled", results: [{ requirementId: "tool", run }] };
    }
    const snapshot = structuredClone(f.task);
    expect(f.controller.backToBuilder(f.scope, "before review", new Set([f.scope.work.productId]))).toBe(false);
    expect(f.task).toEqual(snapshot); expect(f.calls).toEqual([]);
    expect(f.notes[0]).toMatchObject({ productId: f.scope.work.productId, text: expect.stringContaining("cleanup has not been confirmed") });
  });

  it("does not infer a live process from a legacy result with no native observation (shared: " + shared + ")", () => {
    const f = checkRepairs(shared), run = observedCheck(); delete run.execution;
    f.scope.work.checks = { at: 1, results: [run] }; f.controller.recordFailedFindings(f.scope, [run]);
    expect(f.controller.backToBuilder(f.scope, "before review", new Set([f.scope.work.productId]))).toBe(true);
    expect(f.scope.work.checkReturns).toBe(1);
  });
}

it.each(["delivery check", "shipping"])("a late shared repair goes through review again before %s", kind => {
  const f = checkRepairs(true), stages = f.task.plan!.stages;
  stages.push({ id: "delivery", title: "Your check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
    { id: "shipping", title: "Ship", kind: "do", roleId: "release-manager", profileIds: [] });
  f.task.stageIndex = kind === "delivery check" ? 3 : 4;
  f.task.repositories!.forEach(work => Object.assign(work, { approvedSha: "approved", approvedPatch: "patch", approvedFor: { by: "coordinator", mode: work.delivery, destination: "main" } }));
  let saved: typeof f.task | undefined;
  f.host.checkpoint = () => { f.calls.push("checkpoint"); saved = structuredClone(f.task); };
  f.controller.recordFailedFindings(f.scope, [observedCheck()]);
  expect(f.controller.backToBuilder(f.scope, "on what was about to ship", new Set(["a"])) ).toBe(true);
  expect(f.task.repair).toMatchObject({ products: ["a"], returnStage: 2, kind: "checks" });
  expect(f.task.repositories!.map(work => [work.approvedSha, work.approvedPatch, work.approvedFor])).toEqual([[undefined, undefined, undefined], [undefined, undefined, undefined]]);
  expect(f.checkpoints).toHaveLength(1);
  // The original first checkpoint precedes approval withdrawal; the second persists it.
  expect(f.checkpoints[0]!.repositories![0]!.approvedSha).toBe("approved");
  expect(saved!.repositories!.map(work => [work.approvedSha, work.approvedPatch, work.approvedFor])).toEqual([[undefined, undefined, undefined], [undefined, undefined, undefined]]);
  expect(f.calls).toEqual(["checkpoint"]);
});

it("keeps a published sibling outside repair, approval withdrawal and unresolved-ownership checks", () => {
  const f = checkRepairs(true), second = executionFor(f.task, "b").work;
  f.task.plan!.stages.push({ id: "delivery", title: "Your check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] });
  f.task.stageIndex = 3;
  second.landed = { branch: "main", sha: "published" }; second.approvedSha = "published";
  const run = observedCheck(); run.execution!.cleanup = "unconfirmed"; second.checks = { at: 1, results: [run] };
  f.scope.work.approvedSha = "current";
  f.controller.recordFailedFindings(f.scope, [observedCheck()]);
  expect(f.controller.backToBuilder(f.scope, "before shipping", new Set(["a", "b"])) ).toBe(true);
  expect(f.task.repair).toMatchObject({ products: ["a"], returnStage: 3 });
  expect(second.approvedSha).toBe("published"); expect(f.scope.work.approvedSha).toBe("current");
});

it("selects the last preceding custom build stage for a single-product check return", () => {
  const f = checkRepairs();
  const original = f.host.role;
  f.host.role = (id, task) => id === "custom" ? { result: "build" } : original(id, task);
  f.task.plan!.stages.splice(2, 0, { id: "later-build", title: "Custom repair", kind: "do", roleId: "custom", profileIds: [] });
  f.task.stageIndex = 3;
  expect(f.controller.backToBuilder(f.scope, "before review", new Set(["a"]))).toBe(true);
  expect(f.task.stageIndex).toBe(2); expect(f.scope.work.checkReturns).toBe(1);
});

for (const [label, failure] of [["Error", new Error("Cannot save repair")], ["undefined", undefined]] as const) it(`retains a ${label} checkpoint failure instead of reporting a successful shared return`, () => {
  const f = checkRepairs(true); f.controller.recordFailedFindings(f.scope, [observedCheck()]);
  f.host.commitNow = () => { throw failure; };
  let returned = false, error: unknown;
  try { f.controller.backToBuilder(f.scope, "before review", new Set(["a"])); returned = true; } catch (caught) { error = caught; }
  expect(returned).toBe(false); expect(error).toBe(failure); expect(f.calls).toEqual([]);
});
