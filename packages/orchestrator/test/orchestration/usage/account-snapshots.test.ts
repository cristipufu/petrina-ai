import { expect, it } from "vitest";
import type { DeepMutable, Pool, UsageReport } from "@petrina/core";
import { UsageRecording } from "../../../src/usage-recording.js";

const now = 10_000;
const report = { toolId: "provider", model: "old-model", kind: "weekly", status: "rejected" as const, utilization: 1, at: now - 1, resetsAt: now + 1000 };
function fixture(pool: DeepMutable<Pool>) {
  const recorded: UsageReport[] = [];
  let wakes = 0;
  const controller = new UsageRecording({ pool: () => pool, toolName: () => "Provider", record: value => recorded.push(structuredClone(value)), wake: () => wakes++ });
  return { controller, recorded, wakes: () => wakes };
}

it("does not replace confirmed readings or emit effects for an empty or mismatched account snapshot", () => {
  const pool: DeepMutable<Pool> = { limit: 3, paused: false, toolCaps: {}, usage: [report], limited: [{ toolId: report.toolId, model: report.model, source: "report", reason: "Provider's weekly limit", until: report.resetsAt, at: report.at }] };
  const before = structuredClone(pool), f = fixture(pool);
  expect(f.controller.account("provider", [], now)).toBe(false);
  expect(f.controller.account("provider", [{ ...report, toolId: "other" }], now)).toBe(false);
  expect(pool).toEqual(before);
  expect(f.recorded).toEqual([]);
  expect(f.wakes()).toBe(0);
});

it("replaces only the old subscription's report-derived restrictions and records each new scoped reading", () => {
  const refusal = { toolId: "provider", model: "old-model", source: "refusal" as const, reason: "The provider refused a request", until: now + 2000, at: report.at };
  const retry = { toolId: "provider", model: "old-model", retry: true, reason: "Request cooldown", until: now + 2000, at: report.at };
  const unrelated = { toolId: "other", reason: "Another tool's limit", until: now + 3000 };
  const pool: DeepMutable<Pool> = { limit: 3, paused: false, toolCaps: {}, usage: [report], limited: [
    { toolId: "provider", model: "old-model", source: "report", reason: "Provider's weekly limit", until: report.resetsAt, at: report.at }, refusal, retry, unrelated,
  ] };
  const f = fixture(pool);
  const next = { toolId: "provider", model: "new-model", kind: "weekly", status: "allowed" as const, utilization: .1 };
  expect(f.controller.account("provider", [next], now)).toBe(true);
  expect(pool.usage).toEqual([{ ...next, at: now }]);
  expect(pool.limited).toEqual([refusal, retry, unrelated]);
  expect(f.recorded).toEqual([{ ...next, at: now }]);
});

it("looks up the current pool after state replacement rather than mutating the earlier snapshot", () => {
  let pool: DeepMutable<Pool> = { limit: 3, paused: false, toolCaps: {} };
  const first = pool, recorded: UsageReport[] = [];
  const controller = new UsageRecording({ pool: () => pool, toolName: () => "Provider", record: value => recorded.push(structuredClone(value)), wake() {} });
  controller.record({ toolId: "provider", kind: "weekly", status: "allowed", utilization: .1 }, now);
  pool = { limit: 4, paused: true, toolCaps: {} };
  controller.record({ toolId: "provider", kind: "weekly", status: "allowed", utilization: .2 }, now + 1);
  expect(first.usage?.[0]?.utilization).toBe(.1);
  expect(pool.usage?.[0]).toMatchObject({ utilization: .2, at: now + 1 });
  expect(recorded.map(report => report.utilization)).toEqual([.1, .2]);
});
