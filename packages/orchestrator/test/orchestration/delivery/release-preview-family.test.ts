import { expect, it } from "vitest";
import { scopesFor } from "../../../src/repository-context.js";
import { deliveryScenario } from "../../fixtures/delivery-scenarios.js";
import { deferred } from "../../fixtures/check-setup.js";
import { waitDuring } from "../../fixtures/clock.js";

function previewScenario() {
  const f = deliveryScenario(["shop", "api"], "release"); f.approve();
  for (const scope of scopesFor(f.task)) {
    f.prepareObservation(scope);
    scope.work.checkedSha = f.observations.get(scope.work)!.head;
    Object.assign(scope.work.shipping!, { version: "1.0.1", tag: "v1.0.1", after: "v1.0.0" });
    scope.work.releasePreview = { start: f.observations.get(scope.work)!.head, version: "1.0.1", tag: "v1.0.1", after: "v1.0.0", summary: "The supplied preview", notes: "The supplied release notes" };
  }
  return f;
}

it("cleans earlier unpublished release versions before shared approve-again after a later preview mismatch", async () => {
  const f = previewScenario(), [shop, api] = scopesFor(f.task), checked = f.task.repositories!.map(work => work.checkedSha);
  const firstApproval = structuredClone(shop!.work.approvedFor);
  // The native latest-release adapter supplied a changed tag spelling for the second product.
  api!.work.shipping!.tag = "1.0.1";
  expect(shop!.work.shipping?.prepared).toBeDefined();
  expect(await f.workflow.rejectChangedReleasePreview(api!, api!.work.checkedSha!, api!.work.shipping!, api!.work.releasePreview)).toBe("continue");
  expect(f.task.repositories!.map(work => work.checkedSha)).toEqual(checked);
  expect(f.task.plan!.stages[f.task.stageIndex]!.gate).toBe("delivery");
  expect(f.task.repositories!.every(work => !work.shipping?.prepared)).toBe(true);
  expect(api!.work.releasePreview).toBeUndefined(); expect(api!.work.approvedFor).toBeUndefined(); expect(shop!.work.approvedFor).toEqual(firstApproval);
  expect(f.restores).toEqual(["api", "shop"]); expect(f.published).toEqual([]);
  expect(f.notes).toContain("The release preview changed, so shared delivery approval is needed again.");
  // A fresh explicit coordinator choice is an input; the actual Workflow must prepare both
  // again before either supplied transport effect is admitted. No Git/version proof is seeded.
  f.approve(); f.task.stageIndex = 1; f.task.state = "running";
  expect(await f.run(f.task)).toBe("stop");
  expect(f.events.filter(event => /^(prepare|publish):/.test(event))).toEqual(["prepare:delivery:shop", "prepare:delivery:api", "publish:delivery:shop", "publish:delivery:api"]);
  expect(f.published.map(row => row.product)).toEqual(["shop", "api"]);
});

for (const field of ["start", "version", "tag", "after"] as const) it(`withdraws approval for a changed release preview ${field}`, async () => {
  const f = previewScenario(), scope = scopesFor(f.task)[1]!;
  scope.work.releasePreview![field] = "different supplied observation";
  expect(await f.workflow.rejectChangedReleasePreview(scope, scope.work.checkedSha!, scope.work.shipping!, scope.work.releasePreview)).toBe("continue");
  expect(scope.work.approvedFor).toBeUndefined(); expect(f.task.stageIndex).toBe(0);
  expect(f.published).toEqual([]); expect(f.restores).toEqual(["api", "shop"]);
});

it("keeps unchanged previews synchronous and inspects the captured preparation attempt", () => {
  const f = previewScenario(), scope = scopesFor(f.task)[1]!, shipping = scope.work.shipping!, preview = scope.work.releasePreview!;
  scope.work.shipping = { ...shipping, version: "a newer concurrent attempt" };
  expect(f.workflow.rejectChangedReleasePreview(scope, preview.start, shipping, preview)).toBeUndefined();
  expect(f.restores).toEqual([]); expect(f.events).toEqual([]); expect(scope.work.releasePreview).toBe(preview);
});

for (const failure of [new Error("Could not restore the original work"), undefined]) it(`preserves ${failure === undefined ? "undefined" : "Error"} preview restoration failure before withdrawing approval`, async () => {
  const f = previewScenario(), scope = scopesFor(f.task)[1]!;
  scope.work.shipping!.tag = "changed";
  const before = structuredClone(f.task), released = deferred<void>();
  let entered = false;
  f.hooks.backToWork = async () => { entered = true; await released.promise; throw failure; };
  const restoring = f.workflow.rejectChangedReleasePreview(scope, scope.work.checkedSha!, scope.work.shipping!, scope.work.releasePreview)!;
  const operation = restoring.then(value => ({ value }), error => ({ error }));
  try {
    await waitDuring(() => entered, restoring, "the original release restoration"); expect(f.task).toEqual(before); released.resolve();
    expect(await operation).toEqual({ error: failure }); expect(f.task).toEqual(before); expect(f.published).toEqual([]);
  } finally { released.resolve(); await operation; }
});
