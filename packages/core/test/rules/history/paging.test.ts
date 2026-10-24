import { expect, it } from "vitest";
import { demoHistoryPage, historyItem, historyStatus } from "../../../src/history.js";
import type { Task } from "../../../src/model.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const landed = { branch: "main", sha: "abc" };

it("filters by final status before paging without changing the total or mixing routine IDs", () => {
  const state = stateFixture({ now: 1_000_000 });
  const template = taskFixture(state);
  const maintenance = { routineId: "daily", routineName: "Old name", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role: state.roles[0]!, profile: state.profiles[0]!, product: state.products[0]! };
  const tasks: Task[] = Array.from({ length: 8 }, (_, i) => ({ ...template, id: `run-${i}`, title: "Same name", state: "done", productId: "shop", finishedAt: i, pr: undefined, release: undefined, landed: i % 2 ? landed : undefined, maintenance: { ...maintenance, routineId: i === 7 ? "other" : "daily" } }));
  const request = { status: "committed" as const, routineId: "daily", productId: "shop", limit: 2 };
  const first = demoHistoryPage({ ...state, tasks }, request);
  expect(first.total).toBe(3); expect(first.items.map(item => item.id)).toEqual(["run-5", "run-3"]);
  const second = demoHistoryPage({ ...state, tasks }, { ...request, cursor: first.nextCursor });
  expect(second.total).toBe(3); expect(second.items.map(item => item.id)).toEqual(["run-1"]);
  expect(historyStatus(historyItem(tasks[1]!))).toBe("committed");
});
