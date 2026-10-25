import { summaryAt } from '../../fixtures/summary.js';
import { describe, expect, it } from "vitest";

import type { StepRecord, Task } from "../../../src/model.js";

import { leftWords, pauseClock, resumeClock, startClock, timeLeft, workedSoFar } from "../../../src/summary.js";

const MINUTE = 60_000;

describe("how long the step has left", () => {
  const record = (worked: number, at: number, repeat = false): StepRecord => ({ roleId: "builder", repeat, worked, at });

  function board(records: StepRecord[], soFar: number, state: Task["state"] = "running") {
    const fixture = summaryAt("builder");
    const now = 10 * 60 * MINUTE;
    const task: Task = { ...fixture.task, state, stepClock: { roleId: "builder", repeat: false, worked: soFar, since: now } };
    const done: Task = { ...task, id: "done", state: "done", steps: records };
    return { state: { ...fixture.state, now, tasks: [task, done] }, task };
  }

  it("says nothing without history, nothing with two past steps, and a rough time with three", () => {
    expect(timeLeft(board([], 0).state, board([], 0).task)).toBeUndefined();
    const two = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2)], 5 * MINUTE);
    expect(timeLeft(two.state, two.task)).toBeUndefined();
    const three = board([record(20 * MINUTE, 1), record(18 * MINUTE, 2), record(22 * MINUTE, 3)], 5 * MINUTE);
    expect(timeLeft(three.state, three.task)).toBe("About 15 minutes left");
  });

  it("only counts steps of the same kind, the latest ten, and only while the agent works", () => {
    const repeats = board([record(20 * MINUTE, 1, true), record(20 * MINUTE, 2, true), record(20 * MINUTE, 3, true)], 0);
    expect(timeLeft(repeats.state, repeats.task)).toBeUndefined();
    const old = Array.from({ length: 10 }, (_, index) => record(3 * 60 * MINUTE, index));
    const recent = Array.from({ length: 10 }, (_, index) => record(60 * MINUTE, 100 + index));
    const latest = board([...recent, ...old], 0);
    expect(timeLeft(latest.state, latest.task)).toBe("About an hour left");
    // The agent has handed back its result; Petrina may still be tidying up the repository.
    expect(timeLeft(latest.state, { ...latest.task, stepClock: pauseClock(latest.task.stepClock!, latest.state.now) })).toBeUndefined();
    const waiting = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2), record(20 * MINUTE, 3)], 0, "needs-you");
    expect(timeLeft(waiting.state, waiting.task)).toBeUndefined();
  });

  it("says when a step runs past its usual time", () => {
    const late = board([record(20 * MINUTE, 1), record(20 * MINUTE, 2), record(20 * MINUTE, 3)], 25 * MINUTE);
    expect(timeLeft(late.state, late.task)).toBe("Taking longer than usual");
  });

  it("is worded roughly", () => {
    expect(leftWords(3 * MINUTE)).toBe("A few minutes left");
    expect(leftWords(14 * MINUTE)).toBe("About 15 minutes left");
    expect(leftWords(62 * MINUTE)).toBe("About an hour left");
    expect(leftWords(115 * MINUTE)).toBe("About 2 hours left");
    expect(leftWords(0)).toBe("Taking longer than usual");
  });

  it("does not count time spent waiting for the coordinator", () => {
    let clock = startClock(summaryAt("builder").task, "builder", 0);
    clock = pauseClock(clock, 4 * MINUTE);
    expect(workedSoFar(clock, 30 * MINUTE)).toBe(4 * MINUTE);
    clock = resumeClock(clock, 30 * MINUTE);
    expect(workedSoFar(clock, 33 * MINUTE)).toBe(7 * MINUTE);
  });
});
