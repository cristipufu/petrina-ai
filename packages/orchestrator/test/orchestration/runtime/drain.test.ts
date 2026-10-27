import { expect, it } from "vitest";
import { drainRuntime, inFlightWork, keepsIdleSleep } from "../../../src/runtime-drain.js";

it("stops admission before observing owners and reports only changed in-flight counts", async () => {
  let at = 10, index = 0, closed = false;
  const waits: number[] = [], seen: number[] = [], counts = [2, 2, 1, 0];
  const result = await drainRuntime({ requestStop() { closed = true; }, stopped: () => false,
    inFlight() { expect(closed).toBe(true); return counts[index++]!; },
  }, { now: () => at, async sleep(ms) { waits.push(ms); at += ms; } }, 60_000, left => seen.push(left));
  expect(result).toBe(0);
  expect(seen).toEqual([2, 1, 0]);
  expect(waits).toEqual([500, 500, 500]);
});

it("returns the current owned count at the original deadline without altering the cadence", async () => {
  let at = 0;
  const waits: number[] = [], seen: number[] = [];
  expect(await drainRuntime({ requestStop() {}, stopped: () => false, inFlight: () => 2 },
    { now: () => at, async sleep(ms) { waits.push(ms); at += ms; } }, 1500, count => seen.push(count))).toBe(2);
  expect(at).toBe(1500);
  expect(waits).toEqual([500, 500, 500]);
  expect(seen).toEqual([2]);
});

it("finishes on shutdown during a wait and never observes an already stopped owner", async () => {
  let stopped = false, reads = 0, requests = 0;
  const effects = { requestStop() { requests++; }, stopped: () => stopped, inFlight() { reads++; return 2; } };
  const clock = { now: () => 0, async sleep(_ms: number) { stopped = true; } };
  expect(await drainRuntime(effects, clock, 60_000)).toBe(0);
  expect(reads).toBe(1);
  expect(await drainRuntime(effects, clock, 60_000)).toBe(0);
  expect(reads).toBe(1);
  expect(requests).toBe(2);
});

it("counts live agents before finalizers, then retains every independently owned cleanup", () => {
  const owners = { agents: 2, settling: 3, copyCleanups: 1, background: 4, terminals: 2 };
  expect(inFlightWork(owners)).toBe(2);
  expect(inFlightWork({ ...owners, agents: 0 })).toBe(10);
  expect(inFlightWork({ agents: 0, settling: 0, copyCleanups: 0, background: 0, terminals: 0 })).toBe(0);
});

it("keeps sleep prevention for each live ownership source and never after shutdown", () => {
  const none = { stopped: false, drivers: false, settling: false, agents: false, helpers: false, screenGroups: false, switching: false, copyCleanups: false, cleanupJobs: false, extraChecks: false };
  expect(keepsIdleSleep(none)).toBe(false);
  for (const source of ["drivers", "settling", "agents", "helpers", "screenGroups", "switching", "copyCleanups", "cleanupJobs", "extraChecks"] as const) {
    const owners = { ...none, [source]: true };
    expect(keepsIdleSleep(owners)).toBe(true);
    expect(keepsIdleSleep({ ...owners, stopped: true })).toBe(false);
  }
});

for (const error of [new Error("Cleanup retained"), undefined, new AggregateError([new Error("First owner"), undefined], "Peer cleanup retained")]) {
  it(`finishes unrelated admitted work before reporting the exact retained failure: ${String(error)}`, async () => {
    let at = 0, index = 0, requested = false, failureReads = 0;
    const counts = [2, 1, 0], seen: number[] = [], waits: number[] = [];
    const result = await drainRuntime({ requestStop() { requested = true; }, stopped: () => false,
      inFlight() { expect(requested).toBe(true); return counts[index++]!; },
      failure() { failureReads++; expect(index).toBe(3); return { error }; },
    }, { now: () => at, async sleep(ms) { waits.push(ms); at += ms; } }, Infinity, left => seen.push(left))
      .then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error }));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("Retained cleanup became a successful drain");
    expect(result.error).toBe(error); expect(failureReads).toBe(1);
    expect(seen).toEqual([2, 1, 0]); expect(waits).toEqual([500, 500]);
  });
}

it("keeps the original deadline while unrelated work remains despite a known cleanup failure", async () => {
  let at = 0, failureReads = 0;
  const result = await drainRuntime({ requestStop() {}, stopped: () => false, inFlight: () => 1,
    failure() { failureReads++; return { error: new Error("Retained owner") }; },
  }, { now: () => at, async sleep(ms) { at += ms; } }, 1_000);
  expect(result).toBe(1); expect(at).toBe(1_000); expect(failureReads).toBe(0);
});

it("does not report already-stopped retained uncertainty as a successful drain", async () => {
  let reads = 0;
  const result = await drainRuntime({ requestStop() {}, stopped: () => true, inFlight() { reads++; return 0; }, failure: () => ({ error: undefined }) },
    { now: () => 0, async sleep() { throw new Error("A stopped owner must not wait"); } }, Infinity)
    .then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error }));
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("Missing failure value became missing failure presence");
  expect(result.error).toBeUndefined(); expect(reads).toBe(0);
});
