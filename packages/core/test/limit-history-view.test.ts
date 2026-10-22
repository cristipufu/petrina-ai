import { describe, expect, it, vi } from "vitest";
import { initialAllowance, limitBuckets, limitsOverTime, readingChange, readingsView, reportedUsage, type ReadingsRequest } from "../src/limit-history-view.js";
import type { UsageReport } from "../src/model.js";

const now = new Date(2026, 9, 22, 14).getTime();
const hour = 3_600_000;
const report = (extra: Partial<UsageReport> = {}): UsageReport => ({ toolId: "antigravity", kind: "five_hour", model: "gemini", name: "Gemini Models", utilization: 0, status: "allowed", at: now - hour, ...extra });
const view = (history: UsageReport[], current: UsageReport[] = [], period: "today" | "7d" | "30d" = "7d") => limitsOverTime(history, current, limitBuckets(period, now), period === "today", now, id => id);

describe("bounded usage history", () => {
  it("keeps duplicate provider names separate, dates historical Argon and joins only Claude aliases", () => {
    const current = report({ utilization: .08 });
    const history = [report({ model: "flash", at: now - 2 * hour }), report({ model: "argon", kind: "seven_day", name: "Gemini 4 Argon", utilization: 1, at: now - 2 * 24 * hour }),
      report({ toolId: "claude-code", kind: "seven_day_model", model: "fable", name: "fable", utilization: .05 })];
    const before = history.map(report => ({ ...report }));
    const result = view(history, [current, report({ toolId: "claude-code", kind: "seven_day_overage_included", model: "fable", name: "fable", utilization: .09, at: now })]);
    const choices = result.tools.find(tool => tool.toolId === "antigravity")!.limits;
    expect(choices.map(choice => choice.label)).toEqual(expect.arrayContaining(["5-hour · Gemini Models (scope: Flash)", "5-hour · Gemini Models (scope: Gemini)"]));
    expect(choices.find(choice => choice.latest.model === "argon")).toMatchObject({ current: false, latest: { utilization: 1 } });
    expect(choices.find(choice => choice.latest.model === "gemini")!.current).toBe(true);
    expect(result.tools.find(tool => tool.toolId === "claude-code")!.limits).toHaveLength(1);
    expect(history).toEqual(before);
    const caseScopes = view([report({ model: "flash" }), report({ model: "Flash" })]).tools[0]!.limits;
    expect(new Set(caseScopes.map(choice => choice.label)).size).toBe(2);
  });

  it.each([
    ["fable", "seven_day_overage_included"], ["opus", "seven_day_opus"], ["sonnet", "seven_day_sonnet"],
  ])("joins only the proven Claude %s alias, without adding a duplicate current report", (model, kind) => {
    const history = [.05, .06, .08].map((utilization, index) => report({ toolId: "claude-code", kind: "seven_day_model", model, name: model, windowMinutes: 10080, utilization, at: now - (3 - index) * hour }));
    const current = [report({ toolId: "claude-code", kind, model, name: model, windowMinutes: 10080, utilization: .09, at: now })];
    const before = history.map(value => ({ ...value }));
    const result = view(history, current);
    expect(result.tools[0]!.limits).toHaveLength(1);
    expect(result.tools[0]!.limits[0]!.buckets.reduce((sum, bucket) => sum + bucket.numericCount, 0)).toBe(4);
    expect(view([...history, ...current], current)).toEqual(result);
    expect(view(history.map(value => ({ ...value, toolId: "other" })), current.map(value => ({ ...value, toolId: "other" }))).tools[0]!.limits).toHaveLength(2);
    expect(history).toEqual(before);
  });

  it("keeps unnamed provider identities separate with plain, stable allowance names", () => {
    const reports = ["codex:primary", "codex_other:primary"].map(kind => report({ toolId: "codex", kind, model: undefined, name: undefined, windowMinutes: 300 }));
    const choices = view(reports).tools[0]!.limits;
    expect(choices.map(choice => choice.label)).toEqual(["5-hour · All models · Allowance 1", "5-hour · All models · Allowance 2"]);
    expect(view([...reports].reverse()).tools[0]!.limits.map(choice => [choice.key, choice.label])).toEqual(choices.map(choice => [choice.key, choice.label]));
    expect(view([reports[0]!, { ...reports[1]!, name: "Spark" }]).tools[0]!.limits.map(choice => choice.label)).toEqual(["5-hour · All models", "5-hour · Spark"]);
  });

  it("compares reset schedules independently of levels, including across a page boundary", () => {
    const reset = now + 4 * hour - 100;
    const history = Array.from({ length: 23 }, (_, index) => report({ at: now - (23 - index) * 60000, utilization: index / 100, resetsAt: reset + (index % 2 ? 200 : 0) }));
    history.push(report({ at: now, utilization: .23, resetsAt: reset + 60000 }));
    const request: ReadingsRequest = { view: "readings", toolId: "antigravity", allowanceKey: "antigravity|five_hour|gemini", from: now - 24 * hour, to: now + 1, snapshotAt: now, offset: 0 };
    const page = readingsView(history, [], request);
    expect(page.rows[0]!.resetUnchanged).toBe(false);
    expect(page.rows.slice(1).every(row => row.resetUnchanged)).toBe(true);
    expect(readingsView(history, [], { ...request, offset: 20 }).rows.map(row => row.resetUnchanged)).toEqual([true, true, true, false]);
    expect(page.rows[0]!.change).toBe("Higher (was 22%)");
    const missing = readingsView([history[0]!, { ...history[1]!, resetsAt: undefined }, history[2]!], [], request);
    expect(missing.rows.map(row => row.resetUnchanged)).toEqual([false, false, false]);
    expect(page.rows[1]!.report.resetsAt).toBe(reset);
  });

  it("never invents a percentage, distinguishes zero, status-only and missing days, and includes the latest pool report", () => {
    const unavailable = report({ toolId: "claude-code", kind: "overage", utilization: undefined, status: "rejected" });
    expect(reportedUsage(unavailable)).toBe("Extra usage unavailable · percentage not reported");
    expect(reportedUsage(report({ utilization: undefined, status: "rejected" }))).toBe("Limit reached (reported) · no percentage");
    const result = view([report({ at: now - 48 * hour }), report({ at: now - 24 * hour, utilization: undefined })], [report({ utilization: .08, at: now })]);
    const buckets = result.tools[0]!.limits[0]!.buckets;
    expect(buckets.map(bucket => bucket.highest)).toEqual([undefined, undefined, undefined, undefined, 0, undefined, .08]);
    expect(buckets[5]).toMatchObject({ reports: 1, numericCount: 0 });
    expect(buckets[0]).toMatchObject({ reports: 0, numericCount: 0 });
    expect(buckets.at(-1)!.statuses).toEqual(["Allowed (reported)"]);
    expect(view([unavailable]).tools[0]!.limits[0]!.buckets.at(-1)!.highest).toBeUndefined();
    // A provider warning keeps its own percentage, including zero, and never claims to be near the limit.
    const warned = view([report({ status: "allowed_warning", utilization: 0, at: now - hour }), report({ status: "allowed_warning", utilization: undefined, at: now })]).tools[0]!.limits[0]!.buckets.at(-1)!;
    expect(warned).toMatchObject({ highest: 0, reports: 2, numericCount: 1, statuses: ["Provider warning (reported)", "Provider warning · percentage not reported"] });
    expect(reportedUsage(report({ status: "allowed_warning", utilization: undefined }))).toBe("Provider warning · percentage not reported");
    expect(reportedUsage(report({ status: "allowed_warning", utilization: 0.26 }))).toBe("26%");
  });

  it("selects a measured current allowance by shortest window, then the newest current report, then newest history", () => {
    const short = report();
    const weekly = report({ kind: "seven_day", windowMinutes: 10080, at: now });
    const choices = view([report({ model: "argon", utilization: 1 })], [weekly, short]).tools[0]!.limits;
    expect(initialAllowance(choices)!.key).toBe(choices.find(choice => choice.latest.kind === "five_hour" && choice.current)!.key);
    const missing = choices.map(choice => ({ ...choice, buckets: [] }));
    expect(initialAllowance(missing)!.latest.at).toBe(now);
    expect(initialAllowance(missing.map(choice => ({ ...choice, current: false })))!.latest.at).toBe(now);
    expect(initialAllowance(view([], [report({ utilization: undefined, at: now }), weekly]).tools[0]!.limits)!.latest.kind).toBe("seven_day");
  });

  it("ignores forecast drift, fractional jitter and rolling 1% dips, but counts several possible cycles", () => {
    const base = report({ at: now - 4 * hour, utilization: .98, resetsAt: now - 3 * hour });
    const first = report({ at: now - 2 * hour, utilization: .01, resetsAt: now + 3 * hour });
    const high = report({ at: now - hour, utilization: .95, resetsAt: now + 3 * hour });
    const second = report({ at: now, utilization: .02, resetsAt: now + 8 * hour });
    expect(view([base, first, high, second]).tools[0]!.limits[0]!.buckets.at(-1)!.possibleResets).toBe(2);
    expect(readingChange(base, first).text).toBe("Possible reset (was 98%)");
    const tuesday = new Date(2026, 9, 20, 8).getTime();
    const codex = [
      { at: tuesday, utilization: .98, resetsAt: tuesday + hour },
      { at: tuesday + 2 * hour, utilization: .01, resetsAt: tuesday + 6 * hour },
      { at: tuesday + 5 * hour, utilization: .95, resetsAt: tuesday + 6 * hour },
      { at: tuesday + 7 * hour, utilization: .02, resetsAt: tuesday + 11 * hour },
    ].map(value => report({ ...value, toolId: "codex", model: undefined, name: undefined }));
    const cycles = view(codex).tools[0]!.limits[0]!.buckets.find(bucket => bucket.start <= tuesday && bucket.end > tuesday)!;
    expect(cycles.possibleResets).toBe(2);
    expect(view(codex.slice(0, 2)).tools[0]!.limits[0]!.buckets.find(bucket => bucket.start <= tuesday && bucket.end > tuesday)!.possibleResets).toBe(1);
    expect(readingChange(report({ utilization: .05, resetsAt: now + 5 * hour, at: now - hour }), report({ utilization: .04, at: now, resetsAt: now + 6 * hour })).text).toBe("Lower (was 5%)");
    expect(readingChange(report({ utilization: .05, resetsAt: now + hour + .1 }), report({ utilization: .04, resetsAt: now + hour + .9, at: now })).possible).toBe(false);
    const forecasts = Array.from({ length: 108 }, (_, index) => report({ at: now - (108 - index) * 60000, resetsAt: now + index * 60000 }));
    expect(view(forecasts).tools[0]!.limits[0]!.buckets.reduce((sum, bucket) => sum + bucket.possibleResets, 0)).toBe(0);
    expect(readingChange(base, report({ utilization: undefined })).possible).toBe(false);
  });

  it.each([0, 1600, 59999, 60000, 120000])("tolerates forecast drift beyond elapsed time by %s ms in both summaries and readings", (drift) => {
    const before = report({ at: now - 60400, utilization: .02, resetsAt: now + 5 * hour });
    const after = report({ at: now, utilization: .01, resetsAt: before.resetsAt! + 60400 + drift });
    const possible = drift >= 60000;
    const text = possible ? 'Possible reset (was 2%)' : 'Lower (was 2%)';
    expect(readingChange(before, after)).toEqual({ text, possible });
    const summary = view([before, after]);
    const limit = summary.tools[0]!.limits[0]!;
    expect(limit.buckets.at(-1)!.possibleResets).toBe(Number(possible));
    const request: ReadingsRequest = { view: 'readings', toolId: 'antigravity', allowanceKey: limit.key, from: summary.from, to: summary.to, snapshotAt: now, offset: 0 };
    const rows = readingsView([before, after], [], request).rows;
    expect(rows[0]!.change).toBe(text);
    expect(rows[0]!.report.resetsAt).toBe(after.resetsAt);
  });

  it("bounds dense output and pages, keeps source timestamps, and agrees with detail aggregation", () => {
    const history = Array.from({ length: 50000 }, (_, index) => report({ at: now - 29 * 24 * hour + index * 50000, utilization: (index % 101) / 100 }));
    const result = view(history, [], "30d");
    const limit = result.tools[0]!.limits[0]!;
    expect(limit.buckets).toHaveLength(30);
    expect(JSON.stringify(result).length).toBeLessThan(15000);
    expect(JSON.stringify(result)).not.toContain('"readings"');
    expect(limit.buckets.reduce((sum, bucket) => sum + bucket.numericCount, 0)).toBe(50000);
    const request: ReadingsRequest = { view: "readings", toolId: "antigravity", allowanceKey: limit.key, from: result.from, to: result.to, snapshotAt: now, offset: 0 };
    const page = readingsView(history, [], request);
    expect(page.rows).toHaveLength(20);
    expect(page.older).toBe(true);
    expect(page.rows[0]!.report.at).toBe(history.at(-1)!.at);
    const bucket = limit.buckets.find(bucket => bucket.numericCount > 0)!;
    const rows = history.filter(report => report.at >= bucket.start && report.at < bucket.end);
    expect(bucket.highest).toBe(Math.max(...rows.map(report => report.utilization!)));
  });

  it("uses full local days and real hours across Bucharest clock changes without changing UTC times", () => {
    vi.stubEnv("TZ", "Europe/Bucharest");
    try {
      const autumn = limitBuckets("today", Date.parse("2026-10-25T12:00:00Z"));
      expect(autumn).toHaveLength(25);
      expect(autumn.filter(bucket => bucket.label.startsWith("03:" )).map(bucket => bucket.label)).toEqual(["03:00 UTC+03:00", "03:00 UTC+02:00"]);
      const spring = limitBuckets("today", Date.parse("2026-03-29T12:00:00Z"));
      expect(spring).toHaveLength(23);
      expect(spring.some(bucket => bucket.label.startsWith("03:"))).toBe(false);
      expect(limitBuckets("7d", Date.parse("2026-10-25T12:00:00Z")).at(-1)!.end - autumn[0]!.start).toBe(25 * hour);
    } finally { vi.unstubAllEnvs(); }
  });
});
