// The thirty-day history of usage-limit readings in the engine's SQLite work log.
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { UsageReport } from "@petrina/core";
import { WorkLog } from "../src/worklog.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const report = (extra: Partial<UsageReport> & Pick<UsageReport, "at">): UsageReport => ({ toolId: "claude-code", kind: "seven_day", status: "allowed", utilization: 0.5, ...extra });

describe("The history of usage readings", () => {
  it("does no database writes for identical reports and refreshes a reading after retention expires", () => {
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      log.recordUsage(report({ at: NOW }));
      const changes = () => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
      const before = changes();
      expect(log.recordUsage(report({ at: NOW + HOUR }))).toBe(false);
      expect(changes()).toBe(before);
      expect(log.recordUsage(report({ at: NOW + 31 * DAY }))).toBe(true);
      expect(log.usageHistory({}).map((entry) => entry.at)).toEqual([NOW + 31 * DAY]);
    } finally { db.close(); }
  });

  it("finds the highest numeric task id across turns and moments without accepting partial numeric names", () => {
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      expect(log.highestTaskNumber()).toBe(0);
      log.startTurn({ id: "turn", taskId: "task-21", productId: "p", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "codex", profileId: "sol-high", sessionId: "session", reason: "first", startedAt: 1, mainOnly: false, helpers: 0 });
      expect(log.highestTaskNumber()).toBe(21);
      for (const id of ["task-00042", "task-1000-extra", "task-999x", "task--500", "task-", "other-9000", "task-90.5"]) log.addMoment({ id, taskId: id, productId: "p", kind: "untracked", at: 1 });
      expect(log.highestTaskNumber()).toBe(42);
    } finally { db.close(); }
  });

  it("writes a reading only when it differs from the latest one of its limit, keeps thirty days, and answers a period", () => {
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      expect(log.recordUsage(report({ at: NOW - 40 * DAY, utilization: 0.9 }))).toBe(true);
      expect(log.recordUsage(report({ at: NOW - 3 * HOUR, utilization: 0.4, resetsAt: NOW + DAY }))).toBe(true);
      // Claude Code repeats itself on every turn: one row.
      expect(log.recordUsage(report({ at: NOW - 2 * HOUR, utilization: 0.4, resetsAt: NOW + DAY }))).toBe(false);
      expect(log.recordUsage(report({ at: NOW - HOUR, utilization: 0.4, resetsAt: NOW + DAY, model: "opus", kind: "seven_day_opus" }))).toBe(true);
      expect(log.recordUsage(report({ at: NOW, utilization: 0.41, resetsAt: NOW + DAY }))).toBe(true);
      expect(log.recordUsage({ toolId: "codex", kind: "codex:primary", status: "allowed", windowMinutes: 300, name: "Plan", utilization: 0.2, at: NOW })).toBe(true);
      // The reading from forty days ago went when newer ones came.
      const all = log.usageHistory({});
      expect(all.map((entry) => [entry.toolId, entry.kind, entry.utilization, entry.at])).toEqual([
        ["claude-code", "seven_day", 0.4, NOW - 3 * HOUR],
        ["claude-code", "seven_day_opus", 0.4, NOW - HOUR],
        ["claude-code", "seven_day", 0.41, NOW],
        ["codex", "codex:primary", 0.2, NOW],
      ]);
      expect(all[1]).toMatchObject({ model: "opus", resetsAt: NOW + DAY });
      expect(all[0]!.model).toBeUndefined();
      expect(all[3]).toMatchObject({ windowMinutes: 300, name: "Plan" });
      expect(all[3]!.resetsAt).toBeUndefined();
      expect(log.usageHistory({ from: NOW - 90 * 60_000, to: NOW }).map((entry) => entry.at)).toEqual([NOW - HOUR]);
      // A closed log writes nothing more.
      log.close();
      expect(log.recordUsage(report({ at: NOW + HOUR, utilization: 0.6 }))).toBe(false);
      expect(log.usageHistory({})).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});
