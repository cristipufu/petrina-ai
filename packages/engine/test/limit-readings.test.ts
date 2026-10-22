import { expectRejection } from "./rejections.js";
import { codexLimits, limitBuckets, limitsOverTime, type ReadingsView } from "@petrina/core";
import { grokReports } from "../src/grok-usage.js";
import { expect, it, spyOn } from "bun:test";
import { dispatch } from "../src/server.js";
import { Engine } from "./engine.js";
import { removeDir, tempDir } from "./fixtures.js";

it("strictly checks readings requests, bounds their pages, freezes them and never refreshes accounts", async () => {
  const dir = tempDir("limit-readings-");
  const engine = new Engine(dir);
  const refresh = spyOn(engine, "readUsage");
  const now = Date.now();
  try {
    for (let index = 0; index < 45; index++) engine.tracking.usageReported({ toolId: "codex", kind: "five_hour", utilization: index / 100, status: "allowed", at: now - 50000 + index * 1000 });
    const latest = { toolId: "codex", kind: "five_hour", utilization: .5, status: "allowed" as const, at: now - 1 };
    const request = { view: "readings", toolId: "codex", allowanceKey: "codex|five_hour|", from: now - 86400000, to: now + 1, snapshotAt: now, latest, offset: 0 } as const;
    const page = await dispatch(engine, { name: "usage", args: [request] }) as { rows: { report: { utilization: number } }[]; older: boolean };
    expect(page.rows).toHaveLength(20);
    expect(page.older).toBe(true);
    expect(page.rows[0]!.report.utilization).toBe(.5);
    engine.s.pool.usage = [{ ...latest, utilization: .6, at: now + 1000 }];
    engine.tracking.usageReported({ ...latest, utilization: .6, at: now + 1000 });
    expect(await dispatch(engine, { name: "usage", args: [request] })).toEqual(page);
    const older = await dispatch(engine, { name: "usage", args: [{ ...request, offset: 20 }] }) as { rows: unknown[] };
    expect(older.rows).toHaveLength(20);
    expect(refresh).not.toHaveBeenCalled();
    for (const extra of [{ unknown: true }, { latest: { ...latest, utilization: NaN } }, { latest: { ...latest, utilization: Infinity } }, { latest: { ...latest, unexpected: true } }, { latest: { ...latest, at: now + 1 } }, { latest: { ...latest, toolId: "other" } }, { toolId: "a".repeat(201) }, { allowanceKey: "a".repeat(601) }, { from: now + 2 }, { to: now + 32 * 86400000 }, { offset: -20 }, { offset: 100020 }, { offset: 1 }, { snapshotAt: NaN }]) {
      await expectRejection(dispatch(engine, { name: "usage", args: [{ ...request, ...extra }] }));
    }
    expect(refresh).not.toHaveBeenCalled();
  } finally { refresh.mockRestore(); await engine.shutdown(); removeDir(dir); }
});

it.each(["grok", "codex"])("opens %s readings for both ordinary and above-scale percentages without changing the source", async toolId => {
  const dir = tempDir("limit-reading-scale-");
  const engine = new Engine(dir);
  const now = Date.now();
  try {
    for (const percent of [85, 105]) {
      const raw = toolId === "grok" ? grokReports({ config: { creditUsagePercent: percent } })[0]! : codexLimits({ rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300 } } }, now)[0]!;
      const latest = { ...raw, at: now };
      engine.tracking.usageReported(latest);
      const overview = limitsOverTime(engine.tracking.log.usageHistory({}), [latest], limitBuckets("today", now), true, now, id => id);
      const limit = overview.tools[0]!.limits[0]!;
      expect(limit.buckets.find(bucket => bucket.numericCount > 0)!.highest).toBe(Math.min(1, percent / 100));
      const page = await dispatch(engine, { name: "usage", args: [{ view: "readings", toolId, allowanceKey: limit.key, from: overview.from, to: overview.to, snapshotAt: now, latest: limit.latest, offset: 0 }] }) as ReadingsView;
      expect(page.rows[0]!.report.utilization).toBe(percent / 100);
      expect(engine.tracking.log.usageHistory({}).at(-1)!.utilization).toBe(percent / 100);
    }
  } finally { await engine.shutdown(); removeDir(dir); }
});
