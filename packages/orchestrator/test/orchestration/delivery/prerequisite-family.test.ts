import { expect, it } from "vitest";
import { changeRuntimeWait, runtimeWaitHolds, syncRuntimeWait, stepKey } from "@petrina/core";
import { scopesFor } from "../../../src/repository-context.js";
import { deliveryScenario } from "../../fixtures/delivery-scenarios.js";
import { DeliveryObservationFailure } from "../../fixtures/delivery-workflow.js";
import { deferred } from "../../fixtures/check-setup.js";
import { waitDuring } from "../../fixtures/clock.js";

function nextSource(f: ReturnType<typeof deliveryScenario>) {
  const updates: string[] = [];
  f.refreshEffects.update = async bound => {
    updates.push(bound.work.productId);
    const prior = f.observations.get(bound.work)!;
    // These are supplied source adapter observations, deliberately opaque and never native proof.
    f.observations.set(bound.work, { ...prior, head: `scripted:refreshed-head:${bound.work.productId}`, candidate: `scripted:refreshed-candidate:${bound.work.productId}` });
    return "moved";
  };
  return updates;
}

for (const [mode, how] of [["pull-request", "automatic"], ["pull-request", "clear"], ["local", "clear"], ["release", "clear"]] as const)
it(`updates ${mode} before publishing when ${how} release happens inside the final check`, async () => {
  const f = deliveryScenario(["shop"], mode); f.approve();
  const updates = nextSource(f), checked: string[] = [];
  let interrupted = false;
  f.hooks.checksBeforeShipping = async () => {
    checked.push(f.observations.get(f.scope.work)!.head);
    if (!interrupted) {
      interrupted = true; f.hold();
      if (how === "clear") f.release();
      else {
        const prerequisite = f.add("prerequisite", ["shop"]); prerequisite.state = "done";
        prerequisite.repository!.landed = { branch: "main", sha: "scripted:landed-prerequisite-observation" };
        syncRuntimeWait(f.task, id => f.tasks.get(id), f.now());
      }
    }
    return "passed";
  };
  expect(await f.run(f.task)).toBe("continue");
  expect(f.published).toEqual([]); expect(f.task.runtimeWait?.refreshPending).toBe(true);
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(updates).toEqual(["shop"]);
  expect(await f.run(f.task)).toBe("stop");
  expect(checked).toEqual(["supplied-head-1", "scripted:refreshed-head:shop"]);
  expect(f.published.map(row => row.candidate)).toEqual(["scripted:refreshed-candidate:shop"]);
  expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
});

it("holds an unreleased wait after the running final check settles", async () => {
  const f = deliveryScenario(["shop"], "pull-request"); f.approve();
  const released = deferred<void>(); let checks = 0, entered = false;
  f.hooks.checksBeforeShipping = async () => { checks++; entered = true; await released.promise; return "passed"; };
  f.drivers.add(f.task.id);
  const driving = f.run(f.task);
  const operation = driving.then(value => ({ value }), error => ({ error }));
  try {
    await waitDuring(() => entered, driving, "the actual final check"); f.hold(); released.resolve();
    expect(await operation).toEqual({ error: expect.any(DeliveryObservationFailure) });
    expect(checks).toBe(1); expect(runtimeWaitHolds(f.task)).toBe(true); expect(f.published).toEqual([]);
  } finally { released.resolve(); await operation; f.drivers.delete(f.task.id); }
});

it("keeps the paused-pool status specific to publishing for a task without a wait", async () => {
  const f = deliveryScenario(["shop"], "pull-request"); f.state.paused = true;
  await expect(f.run(f.task)).rejects.toMatchObject({ kind: "waiting", message: "Waiting for the pool to resume before publishing" });
  expect(f.published).toEqual([]); expect(f.task.runtimeWait).toBeUndefined();
});

for (const how of ["automatic", "clear"] as const) it(`rechecks and publishes the current PR candidate after ${how} release`, async () => {
  const f = deliveryScenario(["shop"], "pull-request"); f.approve(); f.prepareObservation(f.scope);
  f.scope.work.shipping!.moves = 1; f.scope.work.shipping!.failures = 1;
  f.hold();
  if (how === "clear") f.release();
  else {
    const prerequisite = f.add("prerequisite", ["shop"]); prerequisite.state = "done";
    prerequisite.repository!.landed = { branch: "main", sha: "scripted:landed-prerequisite-observation" };
    syncRuntimeWait(f.task, id => f.tasks.get(id), f.now());
  }
  const updates = nextSource(f);
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(f.scope.work.shipping).toEqual({ moves: 1, failures: 1 });
  expect(updates).toEqual(["shop"]); expect(await f.run(f.task)).toBe("stop");
  expect(f.published.map(row => row.candidate)).toEqual(["scripted:refreshed-candidate:shop"]);
  expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
});

it("keeps the before-preparation PR path on the same current-code check boundary", async () => {
  const f = deliveryScenario(["shop"], "pull-request"); f.approve(); f.hold(); f.release();
  const updates = nextSource(f), checked: string[] = [];
  f.hooks.checksBeforeShipping = async bound => { checked.push(f.observations.get(bound.work)!.head); return "passed"; };
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(await f.run(f.task)).toBe("stop");
  expect(updates).toEqual(["shop"]); expect(checked).toEqual(["scripted:refreshed-head:shop"]);
  expect(f.published.map(row => row.candidate)).toEqual(["scripted:refreshed-candidate:shop"]);
});

it("asks for approval again if the candidate changes after the wait update", async () => {
  const f = deliveryScenario(["shop"], "pull-request"); f.approve(); f.hold(); f.release(); nextSource(f);
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  const current = f.observations.get(f.scope.work)!;
  f.observations.set(f.scope.work, { ...current, patch: "scripted:unapproved-change" });
  expect(await f.run(f.task)).toBe("continue");
  expect(f.task.stageIndex).toBe(0); expect(f.scope.work.approvedSha).toBeUndefined(); expect(f.published).toEqual([]);
});

it("refreshes every product before the first unstarted step while preserving accepted work", async () => {
  const f = deliveryScenario(["shop", "api"]); f.hold(); f.release();
  const before = structuredClone(f.task.rounds), updates = nextSource(f);
  f.task.stageIndex = 0;
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(updates).toEqual(["shop", "api"]); expect(f.task.stageIndex).toBe(0); expect(f.task.rounds).toEqual(before);
  expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
  expect(scopesFor(f.task).map(({ work }) => f.observations.get(work)!.candidate)).toEqual(["scripted:refreshed-candidate:shop", "scripted:refreshed-candidate:api"]);
});

it("settles interrupted admitted publishing while the refreshed companion can proceed", async () => {
  const f = deliveryScenario(["shop", "api"]); f.approve();
  for (const bound of scopesFor(f.task)) f.prepareObservation(bound);
  const first = f.scope.work, admitted = first.shipping!.prepared!.tested; first.shipping!.step = "update";
  f.hold(); f.release(); const updates = nextSource(f);
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(f.task.runtimeWait?.refreshProducts).toEqual(["shop"]); expect(first.shipping!.prepared!.tested).toBe(admitted);
  expect(updates).toEqual(["api"]);
  expect(await f.run(f.task)).toBe("stop");
  expect(f.published.map(row => [row.product, row.candidate])).toEqual([["shop", admitted], ["api", "scripted:refreshed-candidate:api"]]);
  expect(f.task.runtimeWait?.refreshPending).toBeUndefined(); expect(f.task.rounds).toEqual({});
});

for (const failure of [new Error("Source observation rejected"), undefined]) it(`retains the bound refresh obligation after ${failure === undefined ? "undefined" : "Error"}`, async () => {
  const f = deliveryScenario(["shop", "api"]); f.hold(); f.release();
  f.refreshEffects.update = async () => { throw failure; };
  let rejected = false, caught: unknown;
  try { await f.refresh.run(f.task, f.signal); } catch (error) { rejected = true; caught = error; }
  expect(rejected).toBe(true); expect(caught).toBe(failure);
  expect(f.task.runtimeWait?.refreshProducts).toEqual(["shop", "api"]); expect(f.task.runtimeWait?.refreshPending).toBe(true); expect(f.published).toEqual([]);
});

it("keeps the original task and wait bound across an awaited source check and stops before the next owner on cancellation", async () => {
  const f = deliveryScenario(["shop", "api"]); f.hold(); f.release();
  const original = f.task.runtimeWait!, released = deferred<void>(), controller = new AbortController(), calls: string[] = [];
  let entered = false;
  f.refreshEffects.update = async bound => { calls.push(bound.work.productId); entered = true; await released.promise; return "moved"; };
  const refreshing = f.refresh.run(f.task, controller.signal);
  const operation = refreshing.then(value => ({ value }), error => ({ error }));
  try {
    await waitDuring(() => entered, refreshing, "the actual source observation"); changeRuntimeWait(f.task, { after: ["another"], reason: "A new wait while observing source" }, f.now()); controller.abort(); released.resolve();
    expect(await operation).toEqual({ error: expect.any(DeliveryObservationFailure) });
    expect(calls).toEqual(["shop"]); expect(original.refreshProducts).toEqual(["shop", "api"]);
    expect(f.task.runtimeWait).not.toBe(original); expect(f.task.runtimeWait!.after).toEqual(["another"]);
  } finally { released.resolve(); await operation; }
});

for (const clean of [true, false]) it(`observes failed edit cleanup before asking whether refresh is due: clean=${clean}`, async () => {
  const f = deliveryScenario(); f.hold(); f.release();
  f.scope.work.editAttempt = { step: stepKey(f.task), failed: true };
  const calls: string[] = [];
  f.refreshEffects.clean = async () => { calls.push("clean"); return clean; };
  f.refreshHost.due = () => { calls.push("due"); expect(!!f.scope.work.editAttempt).toBe(!clean); return false; };
  expect(await f.refresh.run(f.task, f.signal)).toBe(false); expect(calls).toEqual(["clean", "due"]);
  expect(f.task.runtimeWait?.refreshPending).toBe(true);
});

it("retains only the conflicted owner's refresh obligation after its peer settles", async () => {
  const f = deliveryScenario(["shop", "api"]); f.hold(); f.release();
  const updates: string[] = [];
  f.refreshEffects.update = async bound => { updates.push(bound.work.productId); return bound.work.productId === "shop" ? "conflict" : "moved"; };
  expect(await f.refresh.run(f.task, f.signal)).toBe(true);
  expect(updates).toEqual(["shop", "api"]); expect(f.task.runtimeWait?.refreshProducts).toEqual(["shop"]);
  expect(f.task.runtimeWait?.refreshPending).toBe(true); expect(f.published).toEqual([]);
});

it("retires delivered companions without restoring or refreshing their recorded version", async () => {
  const f = deliveryScenario(["shop", "api"]); f.hold(); f.release();
  f.scope.work.landed = { branch: "main", sha: "scripted:confirmed-companion" };
  const before = structuredClone(f.scope.work), updates = nextSource(f);
  expect(await f.refresh.run(f.task, f.signal)).toBe(false);
  expect(updates).toEqual(["api"]); expect(f.restores).not.toContain("shop");
  expect(f.scope.work).toEqual(before); expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
});
