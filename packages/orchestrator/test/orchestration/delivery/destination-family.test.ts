import { expect, it } from "vitest";
import { runtimeWaitHolds } from "@petrina/core";
import { scopesFor } from "../../../src/repository-context.js";
import { deferred } from "../../fixtures/check-setup.js";
import { deliveryScenario } from "../../fixtures/delivery-scenarios.js";
import { DeliveryObservationFailure, deliveryWorkflowFixture } from "../../fixtures/delivery-workflow.js";

it("finishes a shared delivery before later single-product requests on either destination", async () => {
  const f = deliveryWorkflowFixture();
  const first = f.add("first-a"), shared = f.add("shared", ["a", "b"]), lastA = f.add("last-a"), lastB = f.add("last-b", ["b"]);
  lastB.productId = "b";
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  for (const task of [shared, lastA, lastB]) {
    expect(f.admission.waitingForTurn(task)).toBeDefined();
    expect(task.agent).toBeUndefined(); expect(task.holdsSlot).toBe(false);
  }
  expect(f.admission.waitingForTurn(lastB)).toContain("shared");
  expect(f.published).toEqual([]);
  for (const task of [first, shared, lastA, lastB]) {
    expect(f.admission.waitingForTurn(task)).toBeUndefined();
    expect(await f.run(task)).toBe("stop");
    f.admission.finishDeliveryTurn(task.id);
  }
  expect(f.published.map(row => [row.product, row.task])).toEqual([["a", "first-a"], ["a", "shared"], ["b", "shared"], ["a", "last-a"], ["b", "last-b"]]);
  expect(f.admission.entries()).toEqual([]);
});

it("checks and lands another branch while a delivery to main still owns its turn", async () => {
  const f = deliveryWorkflowFixture(), first = f.add("first"), other = f.add("other");
  f.admissionHost.destination = bound => `${bound.work.productId}#${bound.work.source!.destination.branch}`;
  f.scope(other).work.source!.destination.branch = "next";
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  expect(f.admission.waitingForTurn(other)).toBeUndefined();
  expect(await f.run(other)).toBe("stop");
  expect(f.published.map(row => row.task)).toEqual(["other"]);
  expect(f.scope(first).work.landed).toBeUndefined();
  expect(await f.run(first)).toBe("stop");
  expect(f.published.map(row => row.task)).toEqual(["other", "first"]);
});

for (const outcome of ["failed", "cancelled"] as const) it(`releases a ${outcome} delivery's turn so the next task checks and lands`, async () => {
  const f = deliveryWorkflowFixture(), first = f.add("first"), second = f.add("second");
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  expect(f.admission.waitingForTurn(second)).toContain("first");
  first.state = outcome === "failed" ? "needs-you" : "cancelled";
  f.admission.finishDeliveryTurn(first.id);
  expect(f.admission.waitingForTurn(second)).toBeUndefined();
  expect(await f.run(second)).toBe("stop");
  expect(f.published.map(row => row.task)).toEqual(["second"]);
  expect(f.scope(first).work.landed).toBeUndefined();
  f.admission.finishDeliveryTurn(second.id);
  expect(f.admission.entries()).toEqual([]);
});

it("refreshes every unpublished shared preparation after yielding its turn for a question", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "b"]), second = f.add("second");
  expect(f.admission.waitingForTurn(task)).toBeUndefined();
  f.prepareObservation(scopesFor(task)[0]!);
  expect(f.admission.yieldForDecision(task)).toBe(true);
  expect(scopesFor(task).every(({ work }) => !work.shipping?.prepared)).toBe(true);
  expect(f.published).toEqual([]);
  expect(await f.run(second)).toBe("stop"); f.admission.finishDeliveryTurn(second.id);
  for (const bound of scopesFor(task)) f.observations.set(bound.work, { head: `scripted:new-head:${bound.work.productId}`, candidate: `scripted:after-question:${bound.work.productId}`, patch: `scripted:patch:${bound.work.productId}` });
  expect(await f.run(task)).toBe("stop");
  expect(f.published.map(row => [row.task, row.candidate])).toEqual([["second", "supplied-candidate-3"], ["shared", "scripted:after-question:a"], ["shared", "scripted:after-question:b"]]);
});

for (const releaseDuringPreparation of [false, true]) it(releaseDuringPreparation
  ? "returns to source updates before preparing a companion when the wait ended during the first preparation"
  : "finishes admitted preparation, then neither prepares the next product nor publishes either product", async () => {
  const f = deliveryScenario(["shop", "api"]), entered = deferred<void>(), released = deferred<void>();
  const prepared: string[] = [];
  f.hooks.prepare = async bound => {
    prepared.push(bound.work.productId); f.prepareObservation(bound);
    if (prepared.length === 1) { entered.resolve(); await released.promise; }
    return "ready";
  };
  f.drivers.add(f.task.id);
  const operation = f.run(f.task).then(result => ({ result }), error => ({ error }));
  try {
    await entered.promise; f.hold();
    if (releaseDuringPreparation) f.release();
    released.resolve();
    if (releaseDuringPreparation) {
      expect(await operation).toEqual({ result: "continue" });
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
    } else {
      expect(await operation).toEqual({ error: expect.any(DeliveryObservationFailure) });
      expect(runtimeWaitHolds(f.task)).toBe(true);
    }
    expect(prepared).toEqual(["shop"]); expect(f.published).toEqual([]);
    expect(scopesFor(f.task).every(({ work }) => !work.landed)).toBe(true);
    expect(scopesFor(f.task)[1]!.work.shipping).toBeUndefined();
    expect(f.task.rounds).toEqual({});
  } finally { released.resolve(); await operation; f.drivers.delete(f.task.id); }
});

it("finishes the first product's admitted publication and holds the prepared companion until release", async () => {
  const f = deliveryScenario(["shop", "api"]), entered = deferred<void>(), released = deferred<void>();
  const publish = f.effects.publish;
  f.hooks.publish = async bound => {
    if (bound.work.productId === "shop") { entered.resolve(); await released.promise; }
    // The default scripted transport result is used only after the real publication admission.
    delete f.hooks.publish;
    try { return await publish(bound, f.signal); } finally { f.hooks.publish = effect; }
  };
  const effect = f.hooks.publish;
  f.drivers.add(f.task.id);
  const operation = f.run(f.task).then(result => ({ result }), error => ({ error }));
  try {
    await entered.promise;
    expect(scopesFor(f.task).every(({ work }) => !!work.shipping?.prepared)).toBe(true);
    // An admitted native step keeps its candidate while the new prerequisite closes later admissions.
    f.scope.work.shipping!.step = "update"; f.hold(); released.resolve();
    expect(await operation).toEqual({ error: expect.any(DeliveryObservationFailure) });
    expect(f.published.map(row => row.product)).toEqual(["shop"]);
    expect(scopesFor(f.task)[1]!.work.landed).toBeUndefined();
    expect(runtimeWaitHolds(f.task)).toBe(true);
  } finally { released.resolve(); await operation; f.drivers.delete(f.task.id); }
});

for (const firstAcquisition of [true, false]) it(`revalidates source preparation when ${firstAcquisition ? "first acquiring" : "reacquiring"} its check-line order`, async () => {
  const f = deliveryScenario(); f.approve();
  if (!firstAcquisition) expect(f.admission.waitingForTurn(f.task)).toBeUndefined();
  const invalidations: boolean[] = [];
  f.hooks.checksBeforeShipping = async (_scope, _signal, preparation) => {
    if (!firstAcquisition) f.admission.releaseDeliveryTurn(f.task.id);
    invalidations.push(preparation.beforeQueue());
    expect(await preparation()).toBe(true);
    return "passed";
  };
  // beforePublishing asks the actual turn owner, whose live order becomes the captured authority.
  expect(await f.workflow.readyToShip(f.scope, f.signal)).toBe("ready");
  expect(invalidations).toEqual([!firstAcquisition]);
  expect(f.published).toEqual([]);
});
