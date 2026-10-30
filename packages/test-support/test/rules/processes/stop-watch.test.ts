import { expect, it } from "bun:test";
import { watchStopped, type StopWatchEffects } from "../../fixtures/process-stop-watch.js";
import { rejectionOf } from "../../../src/rejections.js";

function fixture(states: ("running" | "unknown" | "ended")[], slow = 8) {
  let now = 0, reads = 0;
  const sleeps: number[] = [];
  const effects: StopWatchEffects = {
    now: () => now, slow: () => slow,
    async sleep(ms) { sleeps.push(ms); now += ms; },
    async state() { return states[Math.min(reads++, states.length - 1)]!; },
  };
  return { effects, sleeps, reads: () => reads, elapsed: () => now };
}
const options = { ms: 250, endsBy: 300_000, maximumSlow: 8, readAllowanceMs: 3_000 };

it("refuses a program that could end by itself before the longest watch, without reading or waiting", async () => {
  const f = fixture(["ended"]);
  const failure = await rejectionOf(watchStopped("a program due to end by itself", { ...options, ms: 5_000, endsBy: 30_000 }, f.effects));
  expect(String(failure)).toContain("Cannot watch for a program due to end by itself: it could end by itself while watched");
  expect(f.reads()).toBe(0);
  expect(f.sleeps).toEqual([]);
});

for (const [state, what] of [
  ["unknown", "a program whose state cannot be read"],
  ["running", "the program holding the output to stop"],
  ["running", "the unconfirmed program to stop"],
] as const) it(`does not accept ${what} without an ended observation at the maximum busyness factor`, async () => {
  const f = fixture([state]);
  expect(String(await rejectionOf(watchStopped(what, options, f.effects)))).toContain(`Timed out waiting for ${what}`);
  expect(f.elapsed()).toBe(2_050);
  expect(f.reads()).toBe(42);
  expect(f.sleeps.every(ms => ms === 50)).toBe(true);
});

it("accepts an actual ended observation after running and unreadable observations", async () => {
  const f = fixture(["running", "unknown", "ended"]);
  await watchStopped("a stopped program", options, f.effects);
  expect(f.reads()).toBe(3);
  expect(f.sleeps).toEqual([50, 50]);
});

it("caps the live busyness factor at the existing maximum", async () => {
  const f = fixture(["running"], 100);
  expect(String(await rejectionOf(watchStopped("a stopped program", options, f.effects)))).toContain("Timed out waiting for a stopped program");
  expect(f.elapsed()).toBe(2_050);
});
