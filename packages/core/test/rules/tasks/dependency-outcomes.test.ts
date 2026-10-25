import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { expect, it } from "vitest";
import { createTaskState } from "../../../src/index.js";

it("records canonical and shared landing outcomes honestly without changing whether they block", async () => {
  const { syncWait, blocksDependents } = await import("../../../src/index.js");
  const state = stateFixture({ products: [{ id: "p", name: "Product", repo: "local/product", tone: "blue" }] });
  const base = taskFixture(state, { id: "delivery", title: "Delivery" });
  const pr = { number: 1, url: "https://example.test/1", state: "merged" as const, openedAt: 1 };
  const outcome = (other: typeof base) => {
    const waiting = createTaskState({ productId: "p", title: "Waiting", after: [other.id] }, state.products, { id: "waiting", timelineId: "added", now: 1, priority: 0 }, () => other);
    syncWait(waiting, [other], () => other, 1);
    syncWait(waiting, [], () => other, 2);
    return waiting.journey![0]!.reason;
  };
  expect(outcome({ ...base, state: "done", repository: { productId: "p", delivery: "pull-request", pr } })).toBe("“Delivery” landed");
  const mixed = { ...base, state: "done" as const, repositories: [
    { productId: "p", delivery: "pull-request" as const, completedStages: [], pr },
    { productId: "other", delivery: "pull-request" as const, completedStages: [], pr: { ...pr, state: "closed" as const }, landingAccepted: { at: 1 } },
  ] };
  expect(blocksDependents(mixed)).toBe(false);
  expect(outcome(mixed)).toBe("“Delivery” did not land: closed without merging");
  expect(outcome({ ...mixed, state: "cancelled" })).toBe("“Delivery” did not land: cancelled");
  expect(outcome({ ...mixed, repositories: [...mixed.repositories.slice(0, 1), { productId: "other", delivery: "release", completedStages: [] }] })).toBe("“Delivery” marked as done, delivery not confirmed");
});
