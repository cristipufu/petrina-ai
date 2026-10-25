import { describe, expect, it } from "vitest";

import { pointTotal, runningTotal } from "../../../src/charts.js";
import { createDemo } from "../../../src/demo.js";

import { Simulator } from "../../../src/sim.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

describe("The demo's charts", () => {
  it("shows plausible tokens per day with every split, and limits that fill up and reset", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const week = sim.usage({ view: "analytics", period: "7d" });
    expect(week.overTime.splits.tool.points.filter((point) => pointTotal(point, "tokens") > 0)).toHaveLength(7);
    expect(week.overTime.splits.model.series.length).toBeGreaterThanOrEqual(4);
    expect(week.overTime.splits.provider.series.map((entry) => entry.label)).toEqual(["Anthropic", "OpenAI"]);
    expect(week.overTime.measures).toEqual(["tokens", "input", "cacheRead", "output", "time"]);
    expect(runningTotal(week.overTime.splits.tool.points, "tokens").at(-1)).toBe(week.headline.tokens.value);
    expect(week.limits.tools.map((tool) => tool.toolId)).toEqual(["claude-code", "codex"]);
    const fiveHour = week.limits.tools[0]!.limits.find((limit) => limit.label === "5-hour · All models")!;
    expect(fiveHour.buckets.reduce((sum, bucket) => sum + bucket.possibleResets, 0)).toBeGreaterThan(3);
    expect(fiveHour.latest).toMatchObject({ at: NOW, utilization: 0.35 });
    const month = sim.usage({ view: "analytics", period: "30d" });
    expect(month.overTime.splits.tool.points.filter((point) => pointTotal(point, "tokens") > 0).length).toBeGreaterThan(20);
    expect(month.limits.tools[0]!.limits.find((limit) => limit.label === "Weekly · All models")!.buckets.reduce((sum, bucket) => sum + bucket.possibleResets, 0)).toBeGreaterThan(0);
    const today = sim.usage({ view: "analytics", period: "today" });
    expect(today.overTime.hourly).toBe(true);
    expect(today.limits.tools[0]!.limits.find((limit) => limit.label === "5-hour · All models")!.latest.resetsAt).toBe(NOW + 90 * 60_000);
  });
});
