import { NOW, HOUR, task, state, logWith } from "../../fixtures/analytics.js";
import { describe, expect, it } from "vitest";

import { Simulator } from "../../../src/sim.js";

describe("A cancelled task's questions", () => {
  it("stay in its work history unanswered, so Analytics still counts how often agents needed you", () => {
    const initial = state([task('question-task', 'shop', { state: 'needs-you', agent: { roleId: 'builder', profileId: 'opus-high', since: NOW - HOUR, step: 0 } })]);
    const question = { id: 'question', taskId: 'question-task', kind: 'question' as const, title: 'Choose a colour', at: NOW - HOUR, blocking: true };
    initial.inbox = [question];
    const demo = { log: logWith([], [{ id: 'ask', taskId: question.taskId, productId: 'shop', kind: 'ask', ask: 'question', at: question.at }]) };
    const sim = new Simulator(initial, { log: demo.log });
    const open = () => demo.log.moments({ taskId: question.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question" && moment.answer === undefined);
    const before = sim.usage({ view: "analytics", period: "7d" }).squad;
    expect(before.asks).toMatch(/unanswered/);
    expect(open().length).toBeGreaterThan(0);
    sim.cancel(question.taskId);
    expect(sim.getState().tasks.find((task) => task.id === question.taskId)?.state).toBe("cancelled");
    // The question is still there, still unanswered, and the squad's line reads the same.
    expect(open().length).toBeGreaterThan(0);
    const after = sim.usage({ view: "analytics", period: "7d" }).squad;
    expect(after.asks).toBe(before.asks);
    expect(after.cancelled).toBe(before.cancelled + 1);
  });
});
