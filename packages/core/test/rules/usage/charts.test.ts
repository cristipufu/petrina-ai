import { describe, expect, it } from "vitest";
import { periodRange } from "../../../src/analytics.js";
import { OTHER_PROVIDER, pointTotal, providerOf, runningTotal, tokensOverTime } from "../../../src/charts.js";

import { CHANGED_LABEL, NOT_CONFIRMED_LABEL, type TokenLine, type WorkTurn } from "../../../src/worklog.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

const toolName = (toolId: string) => ({ "claude-code": "Claude Code", codex: "Codex" })[toolId] ?? toolId;

function turn(id: string, endedAt: number, extra: Partial<WorkTurn> = {}): WorkTurn {
  return {
    id,
    taskId: "task",
    productId: "shop",
    stageId: "task:build",
    stageTitle: "Build",
    stageKind: "do",
    round: 1,
    fixing: false,
    roleId: "builder",
    toolId: "claude-code",
    profileId: "opus-high",
    modelRan: "claude-opus-5-5",
    modelRanName: "Opus 5.5",
    sessionId: "session",
    reason: "first",
    startedAt: endedAt - 10 * 60_000,
    endedAt,
    end: "finished",
    mainOnly: false,
    helpers: 0,
    workMs: 9 * 60_000,
    ...extra,
  };
}

const line = (turnId: string, model: string, counts: Partial<TokenLine>): TokenLine => ({ turnId, model, ...counts });

describe("Tokens over time", () => {
  const week = periodRange("7d", NOW);

  const today = periodRange("today", NOW);

  it("puts each turn's tokens in its day, and in its hour for Today", () => {
    const turns = [turn("a", NOW - 2 * DAY), turn("b", NOW - HOUR), turn("c", NOW - 10 * DAY), turn("running", NOW - 5 * 60_000, { end: undefined, endedAt: undefined })];
    const lines = [line("a", "claude-opus-5-5", { total: 100 }), line("b", "claude-opus-5-5", { total: 10 }), line("c", "claude-opus-5-5", { total: 1000 }), line("running", "claude-opus-5-5", { total: 5 })];
    const days = tokensOverTime(turns, lines, week.buckets, false, toolName).splits.tool.points;
    expect(days).toHaveLength(7);
    expect(days.map((point) => pointTotal(point, "tokens"))).toEqual([0, 0, 0, 0, 100, 0, 10]);
    // Today, per hour: the turn that ended at 14:00 sits in the 14 bucket; a turn still running counts nowhere.
    const hours = tokensOverTime(turns, lines, today.buckets, true, toolName).splits.tool.points;
    expect(hours).toHaveLength(24);
    expect(hours.map((point) => pointTotal(point, "tokens"))).toEqual(Array.from({ length: 24 }, (_, hour) => (hour === 14 ? 10 : 0)));
    expect(hours[14]!.label).toBe("14");
  });

  it("splits the same tokens by tool, by model and by provider, largest first", () => {
    const turns = [turn("claude", NOW - HOUR), turn("codex", NOW - 2 * HOUR, { toolId: "codex", profileId: "sol-high", modelRan: "gpt-6.1", modelRanName: "gpt-6.1" })];
    const lines = [line("claude", "claude-opus-5-5", { input: 100, cacheRead: 800, output: 100, total: 1000 }), line("claude", "claude-haiku-5-5", { input: 50, cacheRead: 100, output: 50, total: 200 }), line("codex", "gpt-6.1", { input: 300, output: 200, total: 500, changed: true })];
    const view = tokensOverTime(turns, lines, week.buckets, false, toolName);
    const last = (split: "tool" | "model" | "provider") => view.splits[split].points.at(-1)!;
    expect(view.splits.tool.series.map((entry) => [entry.label, entry.toolId])).toEqual([
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
    ]);
    expect(last("tool").values).toMatchObject({ "claude-code": { tokens: 1200, input: 150, cacheRead: 900, output: 150 }, codex: { tokens: 500, input: 300, cacheRead: 0, output: 200 } });
    // Models exactly as reported; a Codex turn that rerouted can't be split between models, and its
    // agent time sits with the model its session ran on.
    expect(view.splits.model.series.map((entry) => entry.label)).toEqual(["Opus 5.5", CHANGED_LABEL, "Haiku 5.5", "gpt-6.1"]);
    expect(last("model").values["Opus 5.5"]!.tokens).toBe(1000);
    expect(last("model").values[CHANGED_LABEL]!.tokens).toBe(500);
    expect(last("model").values["gpt-6.1"]).toMatchObject({ tokens: 0, time: 9 * 60_000 });
    expect(view.splits.provider.series.map((entry) => [entry.label, entry.providerId])).toEqual([
      ["Anthropic", "anthropic"],
      ["OpenAI", "openai"],
    ]);
    expect(last("provider").values).toMatchObject({ anthropic: { tokens: 1200 }, openai: { tokens: 500 } });
    // The three splits add up to the same total in every bucket.
    for (let index = 0; index < 7; index += 1) {
      const total = pointTotal(view.splits.tool.points[index]!, "tokens");
      expect(pointTotal(view.splits.model.points[index]!, "tokens")).toBe(total);
      expect(pointTotal(view.splits.provider.points[index]!, "tokens")).toBe(total);
    }
    expect(view.measures).toEqual(["tokens", "input", "cacheRead", "output", "time"]);
  });

  it("puts agent time with the model the session ran on, and offers only the parts the tools reported", () => {
    const turns = [turn("confirmed", NOW - HOUR, { workMs: 60_000 }), turn("unconfirmed", NOW - 2 * HOUR, { modelRan: undefined, modelRanName: undefined, workMs: 30_000 }), turn("switched", NOW - 3 * HOUR, { modelChangedTo: "claude-sonnet-5-5", workMs: 10_000 })];
    const lines = [line("confirmed", "claude-opus-5-5", { total: 100 }), line("unconfirmed", "claude-opus-5-5", { total: 100 }), line("switched", "claude-opus-5-5", { total: 100 })];
    const view = tokensOverTime(turns, lines, week.buckets, false, toolName);
    const todayPoint = view.splits.model.points.at(-1)!;
    expect(todayPoint.values["Opus 5.5"]).toMatchObject({ tokens: 300, time: 60_000 });
    expect(todayPoint.values[NOT_CONFIRMED_LABEL]).toMatchObject({ tokens: 0, time: 30_000 });
    expect(todayPoint.values[CHANGED_LABEL]).toMatchObject({ tokens: 0, time: 10_000 });
    expect(todayPoint.values["claude-code"]).toBeUndefined();
    expect(view.splits.tool.points.at(-1)!.values["claude-code"]).toMatchObject({ tokens: 300, time: 100_000 });
    // Only totals came, so new input, reused input and output are not on offer.
    expect(view.measures).toEqual(["tokens", "time"]);
  });

  it("adds up the running total bucket by bucket, keeping empty days", () => {
    const turns = [turn("a", NOW - 5 * DAY), turn("b", NOW - 3 * DAY), turn("c", NOW - 3 * DAY + HOUR), turn("d", NOW - HOUR)];
    const lines = [line("a", "claude-opus-5-5", { total: 10 }), line("b", "claude-opus-5-5", { total: 20 }), line("c", "claude-opus-5-5", { total: 5 }), line("d", "claude-opus-5-5", { total: 1 })];
    const { points } = tokensOverTime(turns, lines, week.buckets, false, toolName).splits.tool;
    expect(points.map((point) => pointTotal(point, "tokens"))).toEqual([0, 10, 0, 25, 0, 0, 1]);
    expect(runningTotal(points, "tokens")).toEqual([0, 10, 10, 35, 35, 35, 36]);
    expect(runningTotal(points, "time")).toEqual([0, 540_000, 540_000, 1_620_000, 1_620_000, 1_620_000, 2_160_000]);
  });

  it("knows who runs the models behind each tool", () => {
    expect(providerOf("claude-code")).toEqual({ id: "anthropic", label: "Anthropic" });
    expect(providerOf("codex")).toEqual({ id: "openai", label: "OpenAI" });
    expect(providerOf("grok")).toEqual({ id: "xai", label: "xAI" });
    expect(providerOf("something-new")).toBe(OTHER_PROVIDER);
  });

  it("keeps missing reports distinct from zero across every split, including lost work and partially reported parts", () => {
    const turns = [turn("zero", NOW - HOUR), turn("missing", NOW - HOUR, { toolId: "grok", modelRan: "grok-4.7", modelRanName: "Grok" }), turn("lost", NOW - HOUR, { end: "lost", workMs: undefined }), turn("partial", NOW - HOUR)];
    const view = tokensOverTime(turns, [line("zero", "claude-opus-5-5", { total: 0, input: 0, cacheRead: 0, output: 0 }), line("partial", "claude-opus-5-5", { total: 123 })], week.buckets, false, toolName);
    for (const split of ["tool", "model", "provider"] as const) {
      const point = view.splits[split].points.at(-1)!;
      expect(pointTotal(point, "tokens")).toBe(123);
      expect(Object.values(point.values).some((amounts) => amounts.missing?.tokens)).toBe(true);
      expect(Object.values(point.values).some((amounts) => amounts.missing?.time)).toBe(true);
      expect(pointTotal(point, "time")).toBe(27 * 60_000);
    }
    expect(view.splits.tool.points.at(-1)!.values.grok).toMatchObject({ tokens: 0, time: 9 * 60_000, missing: { tokens: true, input: true, cacheRead: true, output: true } });
    expect(view.splits.tool.points.at(-1)!.values["claude-code"]!.missing).toMatchObject({ tokens: true, input: true, cacheRead: true, output: true, time: true });
    const zero = tokensOverTime([turns[0]!], [line("zero", "claude-opus-5-5", { total: 0, input: 0, cacheRead: 0, output: 0 })], week.buckets, false, toolName);
    expect(zero.splits.tool.points.at(-1)!.values["claude-code"]!.missing).toBeUndefined();
    expect(zero.splits.tool.points[0]!.values).toEqual({});
    const totalOnly = tokensOverTime([turns[3]!], [line("partial", "claude-opus-5-5", { total: 123 })], week.buckets, false, toolName);
    expect(totalOnly.splits.tool.points.at(-1)!.values["claude-code"]!.missing).toEqual({ input: true, cacheRead: true, output: true });
  });
});
