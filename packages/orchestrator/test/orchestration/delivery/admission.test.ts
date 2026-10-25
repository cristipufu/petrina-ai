import { expect, it } from "vitest";
import { deliveryAdmissionFixture } from "../../fixtures/delivery-admission.js";
import { executionFor, scopesFor } from "../../../src/repository-context.js";

it("keeps pull-request and release publication outside local destination turns", () => {
  const f = deliveryAdmissionFixture();
  for (const mode of ["pull-request", "release"] as const) {
    const task = f.add(mode), work = executionFor(task).work;
    work.delivery = mode; work.source!.destination.mode = mode;
    work.source!.destination.kind = mode === "release" ? "release" : "new-pr";
    expect(f.admission.waitingForTurn(task)).toBeUndefined();
  }
  const update = f.add("update-pr"), work = executionFor(update).work;
  work.source!.destination.kind = "update-pr";
  expect(f.admission.waitingForTurn(update)).toBeUndefined();
  expect(f.admission.entries()).toEqual([]);
  expect(f.orders.size).toBe(0);
});

it("invalidates only unpublished candidates when a destination is released, keeping admitted publication evidence", () => {
  const f = deliveryAdmissionFixture(), task = f.add("shared", ["a", "b"]);
  const [first, second] = scopesFor(task);
  expect(f.admission.waitingForTurn(task)).toBeUndefined();
  first!.work.shipping = { start: "first", moves: 0, failures: 0, prepared: { tested: "first", summary: "First candidate" } };
  second!.work.shipping = { start: "second", moves: 0, failures: 0, prepared: { tested: "second", summary: "Second candidate" }, step: "push" };
  expect(f.admission.yieldForDecision(task)).toBe(false);
  expect(f.admission.epoch(task)).toBe(0);
  f.admission.releaseDeliveryTurn(task.id);
  expect(first!.work.shipping.prepared).toBeUndefined();
  expect(second!.work.shipping.prepared?.tested).toBe("second");
  expect(f.admission.epoch(task)).toBe(1);
  expect(f.orders.size).toBe(0);
});

it("keeps a waiting driver's request order while live holders and paused final checks retain their own places", () => {
  const f = deliveryAdmissionFixture(), first = f.add("first"), second = f.add("second"), third = f.add("third");
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  expect(f.admission.waitingForTurn(second)).toContain("first");
  f.admission.finishDeliveryTurn(second.id);
  expect(f.admission.waitingForTurn(third)).toContain("first");
  f.admission.releaseDeliveryTurn(first.id);
  expect(f.admission.waitingForTurn(third)).toBe("Waiting for “second” to finish delivering to main");
  expect(f.admission.waitingForTurn(second)).toBeUndefined();
  f.state.paused = true; f.drivers.add(second.id);
  f.admission.syncDeliveryTurns();
  expect(f.admission.entries()).toEqual([{ taskId: second.id, held: true }]);
  expect(f.admission.beforePublishing(executionFor(second), true)).toEqual({ kind: "ready" });
  f.state.draining = true;
  expect(f.admission.beforePublishing(executionFor(second), true)).toEqual({ kind: "wait", reason: "Waiting for the pool to resume" });
});
