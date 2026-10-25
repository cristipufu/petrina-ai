import { expect, it } from "bun:test";
import { UsageReader } from "@petrina/agent-runtime/usage-reader";
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
  reader.stop();
});

it("shares a pending refresh and stops reporting when its reader is stopped", async () => {
  let resolve!: (reports: UsageInfo[]) => void;
  let records = 0, changes = 0;
  const reader = new UsageReader({ name: "Grok", read: () => new Promise((done) => { resolve = done; }), record: () => records++, log: () => {}, changed: () => changes++ });
  const pending = reader.refresh();
  expect(reader.refresh()).toBe(pending);
  expect(reader.snapshot()?.state).toBe("reading");
  reader.stop();
  resolve([{ toolId: "grok", kind: "seven_day", status: "allowed", utilization: 0.57 }]);
  await pending;
  expect(records).toBe(0);
  expect(changes).toBe(1);
});

it("does not treat an empty account response as a fresh usage report", async () => {
  const reader = new UsageReader({ name: "Grok", read: async () => [], record: () => { throw new Error("No reading to record"); }, log: () => {} });
  await reader.refresh();
  expect(reader.snapshot()?.state).toBe("unavailable");
  reader.stop();
});
