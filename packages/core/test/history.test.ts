import { describe, expect, it } from "vitest";
import { createDemoState, demoHistoryPage, historyItem, historyStatus, MemoryWorkLog, Simulator, type HistoryItem, type HistoryStatus, type Task, type WorkTurn } from "../src/index.js";

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

it("gives demo History the same whole-task totals as details across starts, rounds and product scopes", () => {
  const task = { ...state.tasks[0]!, id: "shared", state: "done" as const, finishedAt: state.now, repositories: ["shop", "billing"].map(productId => ({ productId, delivery: "local" as const, completedStages: [] })) };
  const log = new MemoryWorkLog(0);
  const stages = ["plan", "design", "design", "build", "review", "build", "build", "review"] as const;
  for (const [i, stage] of stages.entries()) {
    const turn: WorkTurn = { id: `turn-${i}`, taskId: task.id, productId: i % 2 ? "shop" : "billing", stageId: stage, stageTitle: stage, stageKind: stage === "plan" ? "plan" : "do", round: i + 1, fixing: i === 5, roleId: "custom-role", toolId: "codex", profileId: "sol-high", sessionId: "reused-session", agentRunId: `start-${i}`, reason: i === 6 ? "continue" : "first", startedAt: i, endedAt: i + 1, end: i === 5 ? "agent-stopped" : "finished", workMs: 60_000, tokens: { total: 1000 }, mainOnly: true, helpers: 2 };
    log.addTurn(turn);
    // A replacement report updates that turn, rather than adding it to the total twice.
    log.endTurn(turn.id, { tokens: { total: 2000 } });
  }
  log.addTurn({ ...log.turn("turn-0")!, id: "still-running", end: undefined, endedAt: undefined, tokens: { total: 999_999 } });
  const simulator = new Simulator({ ...state, tasks: [task] }, { log });
  const details = simulator.usage({ view: "task", taskId: task.id });
  expect(details.tokens).toEqual({ value: 16_000, atLeast: false });
  expect(details.time).toEqual({ value: 8 * 60_000, atLeast: false });
  for (const productId of [undefined, "shop", "billing"]) {
    const page = simulator.historyPage({ productId, includeUsage: true });
    expect(page.items[0]!.usage).toEqual({ tokens: details.tokens, time: details.time });
  }
  expect(simulator.historyPage({}).items[0]).not.toHaveProperty("usage");
});
