import type { TokenCounts, TurnReport } from "@petrina/core";
import type { UsageInfo } from "./failures.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** ACP input includes cache reads and writes; Petrina keeps those in disjoint buckets. */
function countsOf(value: unknown): TokenCounts | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const input = number(raw.inputTokens), output = number(raw.outputTokens), cacheRead = number(raw.cachedReadTokens), cacheWrite = number(raw.cacheCreationTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || input < cacheRead + cacheWrite) return undefined;
  const reasoning = number(raw.reasoningTokens);
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, total: input + output, ...(reasoning !== undefined ? { reasoning } : {}) };
}

/** `_meta.usage` counts the whole prompt, including folded subagents. Sibling token
 * fields describe only the last model call; `_meta.totalTokens` is context size. */
export function grokTurnReport(response: unknown): TurnReport | undefined {
  const usage = object(object(object(response)?._meta)?.usage);
  // An unfinished bill cannot be presented as a complete turn. It stays unreported,
  // which the existing work-log accounting marks as missing from the total.
  if (!usage || usage.usageIsIncomplete === true) return undefined;
  const main = countsOf(usage);
  const models = Object.entries(object(usage.modelUsage) ?? {}).flatMap(([model, value]) => {
    const counts = countsOf(value);
    return model.trim() && counts ? [{ model, counts }] : [];
  });
  // A missing per-model row must not make a valid whole-prompt total disappear.
  const completeModels = models.length && (!main || models.reduce((sum, row) => sum + row.counts.total!, 0) === main.total);
  const modelId = object(object(response)?._meta)?.modelId;
  const primary = completeModels && (models.length === 1 ? models[0]!.model : models.some(row => row.model === modelId) ? modelId as string : undefined);
  // An aggregate with no complete breakdown may include other models. Keep its
  // tokens under "Model not reported" instead of crediting them all to the session model.
  const lines = completeModels ? models : main ? [{ model: "", counts: main }] : undefined;
  return main || completeModels ? { ...(main ? { main } : {}), ...(lines ? { models: lines } : {}), ...(primary ? { model: primary } : {}) } : undefined;
}

/** Only capacity leaves this function. Financial account details are never retained. */
export function grokReports(response: unknown): UsageInfo[] {
  const config = object(object(response)?.config);
  const percent = number(config?.creditUsagePercent);
  if (!config || percent === undefined) return [];
  const period = object(config.currentPeriod);
  const end = typeof period?.end === "string" ? Date.parse(period.end) : NaN;
  const kind = period?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "seven_day" : period?.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly" : "limit";
  return [{ toolId: "grok", kind, utilization: percent / 100, status: percent >= 100 ? "rejected" : percent >= 90 ? "allowed_warning" : "allowed", ...(Number.isFinite(end) ? { resetsAt: end } : {}) }];
}
