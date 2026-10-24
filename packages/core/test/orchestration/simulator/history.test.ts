import { expect, it } from "vitest";
import { MemoryWorkLog, type WorkTurn } from "../../../src/worklog.js";
import { Simulator } from "../../../src/sim.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

it("gives demo History the same whole-task totals as details across starts, rounds and product scopes", () => {
  const state = stateFixture({ now: 1_000_000 });
  const task = { ...taskFixture(state), id: "shared", state: "done" as const, finishedAt: state.now, repositories: ["shop", "billing"].map(productId => ({ productId, delivery: "local" as const, completedStages: [] })) };
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
