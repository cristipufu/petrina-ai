import { expect, it } from "vitest";
import { CheckQueue } from "../../../src/check-queue.js";
import { DeliveryTurns } from "../../../src/delivery-turns.js";

it("takes all local destinations together and keeps overlapping requests in order without blocking independent branches", () => {
  let order = 0;
  const turns = new DeliveryTurns(() => ++order);
  expect(turns.request("first", ["product-a#main"])).toEqual({ order: 1 });
  expect(turns.request("shared", ["product-b#main", "product-a#main"])).toEqual({ order: 2, waitingFor: "first" });
  expect(turns.request("later-b", ["product-b#main"])).toEqual({ order: 3, waitingFor: "shared" });
  expect(turns.request("other-branch", ["product-a#next"])).toEqual({ order: 4 });
  expect(turns.request("other-product", ["product-c#main"])).toEqual({ order: 5 });
  expect(turns.entries()).toEqual([
    { taskId: "first", held: true }, { taskId: "shared", held: false }, { taskId: "later-b", held: false },
    { taskId: "other-branch", held: true }, { taskId: "other-product", held: true },
  ]);
  turns.release("first");
  expect(turns.request("shared", ["product-a#main", "product-b#main"])).toEqual({ order: 2 });
  expect(turns.request("later-b", ["product-b#main"])).toEqual({ order: 3, waitingFor: "shared" });
  turns.release("shared");
  expect(turns.request("later-b", ["product-b#main"])).toEqual({ order: 3 });
});

it("returns cancelled and paused requests without retaining destinations, and restart starts with no ownership", () => {
  let order = 0;
  const reserve = () => ++order;
  const turns = new DeliveryTurns(reserve);
  turns.request("holder", ["a#main"]);
  expect(turns.request("cancelled", ["a#main", "b#main"]).waitingFor).toBe("holder");
  turns.release("cancelled");
  expect(turns.request("b", ["b#main"])).toEqual({ order: 3 });
  expect(turns.request("paused", ["a#main"])).toEqual({ order: 4, waitingFor: "holder" });
  turns.release("paused");
  turns.release("holder");
  expect(turns.request("paused", ["a#main"])).toEqual({ order: 5 });
  expect(new DeliveryTurns(reserve).request("after-restart", ["a#main", "b#main"])).toEqual({ order: 6 });
});

it("uses no check capacity while waiting and carries the original request order into the canonical line", async () => {
  const checks = new CheckQueue(() => 1, () => undefined, () => false, { aborted: () => new Error("Stopped"), unavailable: reason => new Error(reason) });
  const turns = new DeliveryTurns(() => checks.reserveOrder());
  const controller = new AbortController();
  const running = await checks.acquire(controller.signal);
  const first = turns.request("first", ["a#main"]);
  const second = turns.request("second", ["a#main"]);
  const starts: string[] = [];
  const review = checks.acquire(controller.signal).then(place => { starts.push("review"); return place; });
  const extra = checks.acquire(controller.signal, true).then(place => { starts.push("extra"); return place; });
  expect(checks.running).toBe(1);
  expect(checks.waiting).toBe(2);
  expect(second).toEqual({ order: first.order + 1, waitingFor: "first" });
  running();
  (await review)();
  const extraPlace = await extra;
  expect(starts).toEqual(["review", "extra"]);
  turns.release("first");
  const admitted = turns.request("second", ["a#main"]);
  expect(admitted).toEqual({ order: second.order });
  const later = checks.acquire(controller.signal, true).then(place => { starts.push("later extra"); return place; });
  const final = checks.acquire(controller.signal, false, admitted.order).then(place => { starts.push("second final"); return place; });
  extraPlace();
  (await final)();
  (await later)();
  expect(starts).toEqual(["review", "extra", "second final", "later extra"]);
  expect(checks.running).toBe(0);
});
