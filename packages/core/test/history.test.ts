import { describe, expect, it } from "vitest";
import { createDemoState, demoHistoryPage, historyItem, historyStatus, type HistoryItem, type HistoryStatus, type Task } from "../src/index.js";

const state = createDemoState(1_000_000);
const base: HistoryItem = { id: "task", productId: "shop", title: "Maintenance", kind: "chore", state: "done", createdAt: 1, delivery: "local", statusLine: "Finished" };
const landed = { branch: "main", sha: "abc" };
const pr = { number: 1, url: "https://github.com/acme/shop/pull/1", state: "merged" as const, openedAt: 1 };
const release = { tag: "v1.0.0", url: "https://github.com/acme/shop/releases/tag/v1.0.0", sha: "abc", publishedAt: 1 };

describe("final task outcomes", () => {
  const cases: [HistoryStatus, Partial<HistoryItem>][] = [
    ["marked-done", {}], ["committed", { landed }], ["released", { landed, release }],
    ["merged", { pr }], ["closed", { pr: { ...pr, state: "closed" } }],
    ["cancelled", { state: "cancelled", landed }], ["combined", { state: "cancelled", combinedInto: "combined-task" }],
    ["no-changes", { maintenance: { noProductChanges: true } }],
    ["committed", { deliveries: [{ productId: "shop", delivery: "local", landed }, { productId: "billing", delivery: "local", nothingToPublish: true }] }],
    ["mixed", { landed, deliveries: [{ productId: "shop", delivery: "local", landed }, { productId: "billing", delivery: "pull-request", pr }] }],
    ["no-changes", { deliveries: [{ productId: "shop", delivery: "local", nothingToPublish: true }] }],
  ];
  for (const [expected, changes] of cases) it(`classifies ${expected}: ${JSON.stringify(changes)}`, () => { expect(historyStatus({ ...base, ...changes })).toBe(expected); expect(historyStatus(JSON.parse(JSON.stringify({ ...base, ...changes })))).toBe(expected); });
  it("filters by final status before paging without changing the total or mixing routine IDs", () => {
    const template = state.tasks[0]!;
    const maintenance = { routineId: "daily", routineName: "Old name", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role: state.roles[0]!, profile: state.profiles[0]!, product: state.products[0]! };
    const tasks: Task[] = Array.from({ length: 8 }, (_, i) => ({ ...template, id: `run-${i}`, title: "Same name", state: "done", productId: "shop", finishedAt: i, pr: undefined, release: undefined, landed: i % 2 ? landed : undefined, maintenance: { ...maintenance, routineId: i === 7 ? "other" : "daily" } }));
    const request = { status: "committed" as const, routineId: "daily", productId: "shop", limit: 2 };
    const first = demoHistoryPage({ ...state, tasks }, request);
    expect(first.total).toBe(3); expect(first.items.map(item => item.id)).toEqual(["run-5", "run-3"]);
    const second = demoHistoryPage({ ...state, tasks }, { ...request, cursor: first.nextCursor });
    expect(second.total).toBe(3); expect(second.items.map(item => item.id)).toEqual(["run-1"]);
    expect(historyStatus(historyItem(tasks[1]!))).toBe("committed");
  });
});
