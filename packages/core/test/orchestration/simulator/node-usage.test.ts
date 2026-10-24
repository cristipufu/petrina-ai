import { describe, expect, it } from "vitest";
import { createDemo } from "../../../src/demo.js";
import { Simulator } from "../../../src/sim.js";
import { NOW } from "../../fixtures/node-usage.js";

describe("exact step usage", () => {
  it("supplies exact marks and step-only usage in sample stories", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { triggers: demo.triggers, log: demo.log, open: demo.open, quirks: demo.quirks });
    const state = sim.getState();
    const task = state.tasks.find(task => task.id === "pricing-refresh")!;
    const step = task.journey!.find(step => step.kind === "agent" && demo.log.turns({ taskId: task.id }).some(turn => turn.journeyId === step.id && turn.tokens))!;
    expect(step).toBeDefined();
    const own = demo.log.turns({ taskId: task.id }).filter(turn => turn.journeyId === step.id);
    expect(sim.usage({ view: "node", taskId: task.id, nodeId: step.id }).tokens.value).toBe(own.reduce((sum, turn) => sum + (turn.tokens?.total ?? 0), 0));
    const grouped = state.tasks.flatMap(task => (task.journey ?? []).map(step => ({ task, step }))).find(({ task, step }) => (step.team?.length ?? 0) > 1 && demo.log.turns({ taskId: task.id }).filter(turn => turn.journeyId === step.id).length > 1)!;
    expect(grouped).toBeDefined();
    const view = sim.usage({ view: "node", taskId: grouped.task.id, nodeId: grouped.step.id });
    expect(view.runs.length).toBeGreaterThan(1);
    expect(new Set(view.runs.map(run => run.seat)).size).toBe(view.runs.length);
  });
});

it.each(["screen", "question"] as const)("keeps a demo %s continuation on its original start after shifting in time", kind => {
  const demo = createDemo(NOW);
  const sim = new Simulator(demo.state, { triggers: demo.triggers, log: demo.log, open: demo.open, quirks: demo.quirks });
  const taskId = kind === "screen" ? "quick-note" : "dark-mode";
  const step = sim.getState().tasks.find(task => task.id === taskId)!.journey!.at(-1)!;
  const before = sim.usage({ view: "node", taskId, nodeId: step.id });
  expect(before.runs).toHaveLength(1);
  if (kind === "screen") sim.allowScreen(taskId);
  else sim.answer(sim.getState().inbox.find(item => item.taskId === taskId && item.kind === "question")!.id, "Both");
  const endedBefore = demo.log.turns({ taskId }).filter(turn => turn.journeyId === step.id && turn.end).length;
  for (let i = 1; i <= 60; i++) {
    sim.tick(NOW + i * 40_000);
    if (demo.log.turns({ taskId }).filter(turn => turn.journeyId === step.id && turn.end).length > endedBefore) break;
  }
  const after = sim.usage({ view: "node", taskId, nodeId: step.id });
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0]!.key).toBe(before.runs[0]!.key);
  expect(after.tokens.value).toBeGreaterThan(before.tokens.value!);
});
