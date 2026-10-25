import { expect, it } from "bun:test";
import { waitForProgress, type ProgressClock } from "../../../src/progress-wait.js";
import { rejectionOf } from "../../../src/rejections.js";

function controlledClock() {
  let now = 0, factor = 1, next = 0, cancelled = 0;
  const timers = new Map<number, { at: number; expired(): void }>(), sleeps: number[] = [];
  const clock: ProgressClock = {
    now: () => now, slow: () => factor,
    arm(expired, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, expired });
      return () => { cancelled++; timers.delete(id); };
    },
    async sleep(ms) { sleeps.push(ms); now += ms; },
  };
  return { clock, timers, sleeps, cancelled: () => cancelled, factor: (value: number) => { factor = value; },
    fire() {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) throw new Error("The wait has no scheduled deadline");
      timers.delete(due[0]); now = due[1].at; due[1].expired();
    } };
}

for (const hasOwner of [false, true]) it("times out a pending predicate " + (hasOwner ? "whose producer also stays pending" : "without a producer"), async () => {
  const f = controlledClock(), progress = Promise.withResolvers<string>(), owner = Promise.withResolvers<void>();
  let checks = 0;
  const waiting = waitForProgress(() => { checks++; return progress.promise; }, "actual progress", 10, hasOwner ? { during: owner.promise } : {}, f.clock);
  try {
    f.fire();
    const failure = await rejectionOf(waiting);
    expect((failure as Error).message).toBe("Timed out waiting for actual progress");
    expect(checks).toBe(1);
    expect(f.timers.size).toBe(0);
    expect(f.cancelled()).toBe(1);
  } finally { progress.resolve("late result"); owner.resolve(); }
});

it("cancels its deadline after immediate and asynchronous progress", async () => {
  for (const asynchronous of [false, true]) {
    const f = controlledClock();
    expect(await waitForProgress(() => asynchronous ? Promise.resolve("recorded") : "recorded", "recorded progress", 10, {}, f.clock)).toBe("recorded");
    expect(f.timers.size).toBe(0);
    expect(f.cancelled()).toBe(1);
  }
});

it("clears its deadline when the predicate rejects, including rejection with undefined", async () => {
  for (const error of [new Error("The predicate failed"), undefined]) {
    const f = controlledClock(), owner = Promise.withResolvers<void>();
    try {
      expect(await rejectionOf(waitForProgress(() => Promise.reject(error), "a result", 10, { during: owner.promise }, f.clock))).toBe(error);
      expect(f.timers.size).toBe(0);
      expect(f.cancelled()).toBe(1);
    } finally { owner.resolve(); }
  }
});

it("reevaluates the existing load multiplier when a pending predicate reaches its first bound", async () => {
  const f = controlledClock(), progress = Promise.withResolvers<string>();
  const waiting = waitForProgress(() => progress.promise, "busy progress", 10, {}, f.clock);
  try {
    f.factor(2); f.fire();
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0]!.at).toBe(21);
    f.fire();
    expect((await rejectionOf(waiting) as Error).message).toBe("Timed out waiting for busy progress");
    expect(f.timers.size).toBe(0);
  } finally { progress.resolve("late result"); }
});

it("retains the fifty millisecond poll and checks already available progress first", async () => {
  const f = controlledClock(); let checks = 0;
  expect(await waitForProgress(() => ++checks === 2 ? "ready" : false, "next check", 10, {}, f.clock)).toBe("ready");
  expect(checks).toBe(2);
  expect(f.sleeps).toEqual([50]);
  expect(f.timers.size).toBe(0);
});

for (const ms of [-1, NaN, Infinity]) it("rejects an unbounded or invalid fixture timeout: " + ms, async () => {
  const f = controlledClock();
  expect(await rejectionOf(waitForProgress(() => false, "invalid wait", ms, {}, f.clock))).toBeInstanceOf(RangeError);
  expect(f.timers.size).toBe(0);
});
