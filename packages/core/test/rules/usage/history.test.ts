import { describe, expect, it } from "vitest";

import type { UsageReport } from "../../../src/model.js";

import { USAGE_HISTORY_MS, readingsIn, recordReading, sameReading } from "../../../src/usage-history.js";
import { MemoryWorkLog } from "../../../src/worklog.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

const report = (extra: Partial<UsageReport> & Pick<UsageReport, "at">): UsageReport => ({ toolId: "claude-code", kind: "seven_day", status: "allowed", utilization: 0.5, ...extra });

describe("The history of readings", () => {
  it("keeps a reading only when it differs from the last one of its limit, and only thirty days", () => {
    const history: UsageReport[] = [];
    expect(recordReading(history, report({ at: NOW - 40 * DAY, utilization: 0.9 }))).toBe(true);
    expect(recordReading(history, report({ at: NOW - 2 * HOUR }))).toBe(true);
    expect(history).toHaveLength(1);
    // The same percentage again: not written. The same percentage of another limit: written.
    expect(recordReading(history, report({ at: NOW - HOUR }))).toBe(false);
    expect(recordReading(history, report({ at: NOW - HOUR, kind: "seven_day_opus", model: "opus" }))).toBe(true);
    expect(recordReading(history, report({ at: NOW, utilization: 0.51 }))).toBe(true);
    expect(history.map((entry) => [entry.kind, entry.utilization, entry.at])).toEqual([
      ["seven_day", 0.5, NOW - 2 * HOUR],
      ["seven_day_opus", 0.5, NOW - HOUR],
      ["seven_day", 0.51, NOW],
    ]);
    // A late report lands in its place in time.
    expect(recordReading(history, report({ at: NOW - 90 * 60_000, utilization: 0.49 }))).toBe(true);
    expect(history.map((entry) => entry.at)).toEqual([NOW - 2 * HOUR, NOW - 90 * 60_000, NOW - HOUR, NOW]);
    expect(readingsIn(history, { from: NOW - HOUR, to: NOW }).map((entry) => entry.at)).toEqual([NOW - HOUR]);
    expect(sameReading(report({ at: 1 }), report({ at: 2 }))).toBe(true);
    expect(sameReading(report({ at: 1 }), report({ at: 1, resetsAt: 5 }))).toBe(false);
    expect(USAGE_HISTORY_MS).toBe(30 * DAY);
  });

  it("is kept by the simulator's log and copied with it", () => {
    const log = new MemoryWorkLog(NOW - DAY);
    expect(log.recordUsage(report({ at: NOW - HOUR }))).toBe(true);
    expect(log.recordUsage(report({ at: NOW }))).toBe(false);
    expect(log.usageHistory({})).toHaveLength(1);
    const copy = log.copy();
    copy.recordUsage(report({ at: NOW, utilization: 0.6 }));
    expect(copy.usageHistory({})).toHaveLength(2);
    expect(log.usageHistory({})).toHaveLength(1);
  });
});
