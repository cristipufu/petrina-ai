import type { TurnReport } from "@petrina/core";
import type { UsageInfo } from "./failures.js";

export type { AccountReading as AntigravityReading } from "./tool-adapter.js";
import type { AccountReading as AntigravityReading } from "./tool-adapter.js";

/** Google's built-in /usage command is handled locally, not sent to a model. Only its
 * named figures are read. ACP usage_update.used is context size, never billed tokens. */
export function antigravityReading(text: string): AntigravityReading {
  const reports: UsageInfo[] = [];
  const hasArgon = /^- \*\*Gemini 4 Argon\*\*\s*$/m.test(text);
  let model: string | undefined;
  let name: string | undefined;
  for (const line of text.split("\n")) {
    const group = /^- \*\*([^*]+)\*\*\s*$/.exec(line)?.[1];
    if (group) {
      name = group;
      // Do not apply an unavailable third-party model group's limits to Gemini.
      model = group === "Gemini Models" ? hasArgon ? "flash" : "gemini" : group === "Gemini 4 Argon" ? "argon" : undefined;
      continue;
    }
    if (!model) continue;
    const limit = /^\s*- \*\*([^*]+):\*\* (\d+(?:\.\d+)?)% remaining \(resets ([^)]+)\)\s*$/.exec(line);
    if (!limit) continue;
    const remaining = Number(limit[2]);
    const resetsAt = Date.parse(limit[3]!);
    const kind = /Weekly/.test(limit[1]!) ? "seven_day" : /Five Hour/.test(limit[1]!) ? "five_hour" : undefined;
    if (!kind || remaining < 0 || remaining > 100 || !Number.isFinite(resetsAt)) continue;
    const utilization = (100 - remaining) / 100;
    reports.push({
      toolId: "antigravity",
      model,
      name: name!,
      kind,
      utilization,
      resetsAt,
      status: utilization >= 1 ? "rejected" : utilization >= 0.9 ? "allowed_warning" : "allowed"
    });
  }
  const total = /\*\*Session total:\*\* ([\d,]+) tokens \(prompt: ([\d,]+), completion: ([\d,]+)(?:, thinking: ([\d,]+))?(?:, cached: ([\d,]+))?\)/.exec(text);
  const number = (value: string | undefined) => Number((value ?? "0").replaceAll(",", ""));
  const tokens = total ? {
    total: number(total[1]),
    input: number(total[2]),
    output: number(total[3]) + number(total[4]),
    reasoning: number(total[4]),
    ...(total[5] !== undefined ? { cached: number(total[5]) } : {})
  } : /\*\*Session total:\*\* data not available yet/.test(text) ? {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0
  } : undefined;
  return {
    reports,
    ...(tokens && Object.values(tokens).every(value => Number.isSafeInteger(value) && value >= 0) && tokens.total === tokens.input + tokens.output && (tokens.cached === undefined || tokens.cached <= tokens.input) ? { tokens } : {})
  };
}

/** Cumulative totals include previous turns after resume. Record only this turn's increase.
 * Prompt includes cached input. Split it only when both readings report cache
 * (or the earlier session is empty), never adding cache to the total again. */
export function antigravityTurnReport(before: AntigravityReading | undefined, after: AntigravityReading | undefined): TurnReport | undefined {
  const a = before?.tokens;
  const b = after?.tokens;
  if (!a || !b || b.total < a.total || b.input < a.input || b.output < a.output || b.reasoning < a.reasoning) return undefined;
  const input = b.input - a.input;
  const cached = b.cached !== undefined && (a.cached !== undefined || a.total === 0) ? b.cached - (a.cached ?? 0) : undefined;
  const split = cached !== undefined && cached >= 0 && cached <= input ? { input: input - cached, cacheRead: cached } : {};
  return { main: { total: b.total - a.total, output: b.output - a.output, reasoning: b.reasoning - a.reasoning, ...split } };
}
