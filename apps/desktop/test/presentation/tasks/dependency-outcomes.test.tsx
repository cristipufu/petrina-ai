import { stateFixture, taskFixture } from "../../fixtures/state";
import { expect, it, vi } from "vitest";
import { historyItem, type Task } from "@petrina/core";
import { dependencyOutcome } from "../../../src/components/TaskDependencies";

const commands = vi.hoisted(() => ({ addTask: vi.fn(), setAfter: vi.fn(), historyPage: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", sim: commands, failureText: (failure: Error) => failure.message }));

it("distinguishes unsuccessful and unresolved deliveries from landed prerequisites", () => {
  const state = stateFixture(); const task = taskFixture(state, { title: "Foundation" });
  expect(dependencyOutcome({ ...task, state: "cancelled" })).toContain("Cancelled");
  expect(dependencyOutcome({ ...task, state: "done" })).toContain("delivery not confirmed");
  const pr = { number: 1, url: "https://example.test/1", openedAt: 1 };
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "closed" } })).toContain("did not land");
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "open" } })).toContain("not landed yet");
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "merged" } })).toBe("Landed");
  // You marked it done: a pull request found later, saved or live, does not make it land.
  for (const state of ["open", "merged", "closed"] as const) {
    const marked = { ...task, state: "done" as const, pr: { ...pr, state }, cleanup: { markedDone: true } };
    expect(dependencyOutcome(marked)).toBe("Marked as done — delivery not confirmed");
    expect(dependencyOutcome(historyItem(marked))).toBe("Marked as done — delivery not confirmed");
  }
  const shared: Task = { ...task, state: "done" as const, repositories: [{ productId: "one", delivery: "local" as const, completedStages: [], landed: { branch: "main", sha: "abc" }, localUpdate: { branch: "main", sha: "abc", pushed: false } }] };
  expect(dependencyOutcome(shared)).not.toBe("Landed");
});
