// The Analytics charts over time, worked out from the log the same way for the engine and the
// simulator: tokens per day (per hour for Today) split by tool, by model or by provider, with
// the running total. Account history has its own bounded summaries in limit-history-view.ts.

import type { Id } from "./model.js";
import { lineModelLabel, turnModelLabel, type TokenLine, type WorkTurn } from "./worklog.js";

// ── Providers ──────────────────────────────────────────────────────────────

/** Who runs the models behind a tool. */
export interface Provider {
  id: string;
  label: string;
}

const PROVIDERS: Readonly<Record<Id, Provider>> = {
  "claude-code": { id: "anthropic", label: "Anthropic" },
  codex: { id: "openai", label: "OpenAI" },
  grok: { id: "xai", label: "xAI" },
  gemini: { id: "google", label: "Google" },
  antigravity: { id: "google", label: "Google" },
};

export const OTHER_PROVIDER: Provider = { id: "other", label: "Other" };

/** The provider behind a tool: Anthropic for Claude Code, OpenAI for Codex, xAI for Grok. */
export function providerOf(toolId: Id): Provider {
  return PROVIDERS[toolId] ?? OTHER_PROVIDER;
}

// ── Tokens over time ───────────────────────────────────────────────────────

export type OverTimeSplit = "tool" | "model" | "provider";
export const OVER_TIME_SPLITS: readonly OverTimeSplit[] = ["tool", "model", "provider"];

/** What a bar measures: all tokens, one part of them, or agent time. */
export type OverTimeMeasure = "tokens" | "input" | "cacheRead" | "output" | "time";

/** Known amounts in one bucket. Missing reports are marked separately from measured zero. */
export interface Amounts {
  tokens: number;
  input: number;
  cacheRead: number;
  output: number;
  /** Milliseconds of agent work. */
  time: number;
  missing?: Partial<Record<OverTimeMeasure, boolean>>;
}

export interface OverTimeSeries {
  key: string;
  label: string;
  /** For colours: the tool in the tool split, the provider in the provider split. The model split colours by label. */
  toolId?: Id;
  providerId?: string;
}

export interface OverTimePoint {
  start: number;
  end: number;
  label: string;
  /** Per series key. A series with nothing in the bucket is missing. */
  values: Record<string, Amounts>;
}

export interface OverTimeSplitView {
  series: OverTimeSeries[];
  points: OverTimePoint[];
}

export interface OverTimeView {
  hourly: boolean;
  /** The measures the period's records carry: tokens and time always, the parts only when a tool reported them. */
  measures: OverTimeMeasure[];
  splits: Record<OverTimeSplit, OverTimeSplitView>;
}

export interface Bucket {
  start: number;
  end: number;
  label: string;
}

const emptyAmounts = (): Amounts => ({ tokens: 0, input: 0, cacheRead: 0, output: 0, time: 0 });

const turnAt = (turn: WorkTurn) => turn.endedAt ?? turn.startedAt;

function bucketIndex(buckets: readonly Bucket[], at: number): number {
  return buckets.findIndex((bucket) => at >= bucket.start && at < bucket.end);
}

/** The amount of one measure in a point, over every series. */
export function pointTotal(point: OverTimePoint, measure: OverTimeMeasure): number {
  return Object.values(point.values).reduce((sum, amounts) => sum + amounts[measure], 0);
}

/** The running total of one measure, bucket by bucket. */
export function runningTotal(points: readonly OverTimePoint[], measure: OverTimeMeasure): number[] {
  let sum = 0;
  return points.map((point) => (sum += pointTotal(point, measure)));
}

/** The series that have anything, largest first by tokens, then by time, then by name. */
function orderSeries(series: Map<string, OverTimeSeries>, points: readonly OverTimePoint[]): OverTimeSeries[] {
  const sums = new Map<string, Amounts>();
  for (const point of points) {
    for (const [key, amounts] of Object.entries(point.values)) {
      const sum = sums.get(key) ?? sums.set(key, emptyAmounts()).get(key)!;
      sum.tokens += amounts.tokens;
      sum.time += amounts.time;
    }
  }
  return [...series.values()]
    .filter((entry) => sums.has(entry.key))
    .sort((a, b) => sums.get(b.key)!.tokens - sums.get(a.key)!.tokens || sums.get(b.key)!.time - sums.get(a.key)!.time || a.label.localeCompare(b.label));
}

/**
 * Tokens and agent time per bucket, split three ways at once so the window can switch without
 * asking again. Tokens come from each turn's model lines (so the three splits add up to the same
 * total); agent time comes from the turn, and in the model split sits with the model the agent's
 * session ran on, as in the model split below the chart.
 */
export function tokensOverTime(turns: readonly WorkTurn[], lines: readonly TokenLine[], buckets: readonly Bucket[], hourly: boolean, toolName: (toolId: Id) => string): OverTimeView {
  const turnById = new Map(turns.filter((turn) => turn.end !== undefined).map((turn) => [turn.id, turn]));
  const seriesOf: Record<OverTimeSplit, Map<string, OverTimeSeries>> = { tool: new Map(), model: new Map(), provider: new Map() };
  const pointsOf: Record<OverTimeSplit, OverTimePoint[]> = {
    tool: buckets.map((bucket) => ({ ...bucket, values: {} })),
    model: buckets.map((bucket) => ({ ...bucket, values: {} })),
    provider: buckets.map((bucket) => ({ ...bucket, values: {} })),
  };
  const place = (split: OverTimeSplit, index: number, series: OverTimeSeries): Amounts => {
    if (!seriesOf[split].has(series.key)) seriesOf[split].set(series.key, series);
    const point = pointsOf[split][index]!;
    return (point.values[series.key] ??= emptyAmounts());
  };
  const toolSeries = (turn: WorkTurn): OverTimeSeries => ({ key: turn.toolId, label: toolName(turn.toolId), toolId: turn.toolId });
  const providerSeries = (turn: WorkTurn): OverTimeSeries => {
    const provider = providerOf(turn.toolId);
    return { key: provider.id, label: provider.label, providerId: provider.id };
  };
  const has = { input: false, cacheRead: false, output: false };
  const withLines = new Set<string>();

  for (const line of lines) {
    const owner = turnById.get(line.turnId);
    if (!owner) continue;
    const index = bucketIndex(buckets, turnAt(owner));
    if (index < 0) continue;
    withLines.add(owner.id);
    const label = lineModelLabel(line);
    for (const amounts of [
      place(
      "tool",
      index,
      toolSeries(owner)
    ),
      place(
      "model",
      index,
      {
      key: label,
      label
    }
    ),
      place(
      "provider",
      index,
      providerSeries(owner)
    )
    ]) {
      amounts.tokens += line.total ?? 0;
      amounts.input += line.input ?? 0;
      amounts.cacheRead += line.cacheRead ?? 0;
      amounts.output += line.output ?? 0;
      for (const [measure, value] of [["tokens", line.total], ["input", line.input], ["cacheRead", line.cacheRead], ["output", line.output]] as const) {
        if (value === undefined) (amounts.missing ??= {})[measure] = true;
      }
    }
    if (line.input !== undefined) has.input = true;
    if (line.cacheRead !== undefined) has.cacheRead = true;
    if (line.output !== undefined) has.output = true;
  }
  for (const turn of turnById.values()) {
    const index = bucketIndex(buckets, turnAt(turn));
    if (index < 0) continue;
    const label = turnModelLabel(turn);
    for (const amounts of [
      place(
      "tool",
      index,
      toolSeries(turn)
    ),
      place(
      "model",
      index,
      {
      key: label,
      label
    }
    ),
      place(
      "provider",
      index,
      providerSeries(turn)
    )
    ]) {
      if (turn.workMs === undefined) (amounts.missing ??= {}).time = true;
      else amounts.time += turn.workMs;
      if (!withLines.has(turn.id)) {
        for (const measure of ["tokens", "input", "cacheRead", "output"] as const) (amounts.missing ??= {})[measure] = true;
      }
    }
  }

  const splits = {} as Record<OverTimeSplit, OverTimeSplitView>;
  for (const split of OVER_TIME_SPLITS) splits[split] = { series: orderSeries(seriesOf[split], pointsOf[split]), points: pointsOf[split] };
  const measures: OverTimeMeasure[] = [
    "tokens",
    ...(has.input ? (["input"] as const) : []),
    ...(has.cacheRead ? (["cacheRead"] as const) : []),
    ...(has.output ? (["output"] as const) : []),
    "time"
  ];
  return { hourly, measures, splits };
}
