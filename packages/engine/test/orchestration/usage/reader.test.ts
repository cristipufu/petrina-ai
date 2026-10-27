import { expect, it } from "bun:test";
import { usageResult } from "@petrina/agent-runtime/usage-process";
import { UsageReader } from "@petrina/agent-runtime/usage-reader";
import { rejectionOf } from "@petrina/test-support/rejections";
import type { UsageInfo } from "@petrina/agent-runtime/failures";

it("keeps the last account report when refreshing fails, and exposes recovery separately", async () => {
  const reports: UsageInfo[][] = [], states: string[] = [];
  let fail = false, reads = 0;
  const report: UsageInfo = { toolId: "grok", kind: "seven_day", status: "allowed", utilization: 0.57 };
  const reader = new UsageReader({ name: "Grok", read: async () => { reads++; if (fail) throw new Error("Meter unavailable"); return [report]; }, record: (value) => reports.push(value), log: () => {}, changed: () => states.push(reader.snapshot()!.state) });
  expect(reader.snapshot()).toBeUndefined();
  await reader.refresh();
  expect(states).toEqual(["reading", "reported"]);
  await reader.refresh(60_000);
  expect(reads).toBe(1);
  fail = true;
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("unavailable");
  expect(reports).toEqual([[report]]);
  fail = false;
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("reported");
  expect(reports).toEqual([[report], [report]]);
  await reader.stop();
});

it("shares a pending refresh and stops reporting when its reader is stopped", async () => {
  let resolve!: (reports: UsageInfo[]) => void;
  let records = 0, changes = 0;
  const reader = new UsageReader({ name: "Grok", read: () => new Promise((done) => { resolve = done; }), record: () => records++, log: () => {}, changed: () => changes++ });
  const pending = reader.refresh();
  expect(reader.refresh()).toBe(pending);
  expect(reader.snapshot()?.state).toBe("reading");
  const stopping = reader.stop();
  resolve([{ toolId: "grok", kind: "seven_day", status: "allowed", utilization: 0.57 }]);
  await pending; await stopping;
  expect(records).toBe(0);
  expect(changes).toBe(1);
});

it("does not treat an empty account response as a fresh usage report", async () => {
  const reader = new UsageReader({ name: "Grok", read: async () => [], record: () => { throw new Error("No reading to record"); }, log: () => {} });
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("unavailable");
  await reader.stop();
});


it("reserves a read before synchronous stop reentry and joins its late cleanup", async () => {
  let finishRead!: (reports: UsageInfo[]) => void, finishNative!: () => void;
  let completed = false, reported = false, records = 0;
  let stopping: Promise<void> | undefined;
  const reader = new UsageReader({ name: "Controlled", read(context) {
    context.signal.addEventListener("abort", () => {
      context.onGone(new Promise<void>(resolve => { finishNative = () => { completed = true; resolve(); }; }));
      finishRead([]);
    }, { once: true });
    return new Promise(resolve => { finishRead = resolve; });
  }, record: () => records++, log() {}, changed() {
    stopping = reader.stop();
    expect(reader.stop()).toBe(stopping);
  } });
  const reading = reader.refresh();
  const stopped = reader.stop();
  if (!stopping) throw new Error("The synchronous observer did not request stop");
  expect(stopped).toBe(stopping);
  const observed = stopped.then(() => { reported = completed; });
  try {
    expect(reader.refresh()).toBeInstanceOf(Promise);
    finishNative();
    await reading; await observed;
    expect(reported).toBe(true); expect(records).toBe(0);
  } finally { finishNative?.(); await stopped; }
});

for (const error of [new Error("Native cleanup failed"), undefined]) it(`retains cleanup rejection ${String(error)} after the report finishes`, async () => {
  let reads = 0;
  const reader = new UsageReader({ name: "Controlled", read: async context => {
    reads++; context.onGone(Promise.reject(error)); return [];
  }, record() { throw new Error("No complete report was supplied"); }, log() {} });
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("unavailable");
  await reader.refresh(); expect(reads).toBe(1);
  const stopped = reader.stop();
  expect(reader.stop()).toBe(stopped);
  expect(await rejectionOf(stopped)).toBe(error);
});

it("keeps a logical read failure nonfatal after native cleanup is confirmed", async () => {
  const failure = new Error("Account refused the request"), reports: UsageInfo[][] = [];
  const reader = new UsageReader({ name: "Controlled", read: async context => {
    context.onGone(Promise.resolve()); throw failure;
  }, record: value => reports.push(value), log() {} });
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("unavailable"); expect(reports).toEqual([]);
  await reader.stop();
});

it("joins every cleanup peer before reporting ordered Error and undefined failures", async () => {
  let release!: () => void, peerDone = false;
  const first = new Error("First native owner failed");
  const reader = new UsageReader({ name: "Controlled", read: async context => {
    context.onGone(Promise.reject(first));
    context.onGone(new Promise<void>((_, reject) => { release = () => { peerDone = true; reject(undefined); }; }));
    return [];
  }, record() {}, log() {} });
  const reading = reader.refresh(), stopped = reader.stop();
  const observed = rejectionOf(stopped).then(error => ({ error, peerDone }));
  try {
    release(); await reading;
    const result = await observed;
    expect(result.peerDone).toBe(true); expect(result.error).toBeInstanceOf(AggregateError);
    const errors = (result.error as AggregateError).errors;
    expect(errors).toHaveLength(2); expect(errors[0]).toBe(first); expect(errors[1]).toBeUndefined();
  } finally { release(); await observed; }
});


for (const body of [new Error("Account protocol failed"), undefined]) for (const cleanup of [new Error("Actual cleanup failed"), undefined])
it(`preserves read and cleanup failures: ${String(body)}, ${String(cleanup)}`, async () => {
  const failure = await rejectionOf(usageResult(async () => { throw body; }, async () => { throw cleanup; }));
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors;
  expect(errors).toHaveLength(2); expect(errors[0]).toBe(body); expect(errors[1]).toBe(cleanup);
});
