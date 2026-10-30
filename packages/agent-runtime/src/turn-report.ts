import type { TokenCounts, TurnReport } from "@petrina/core";

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function defined(counts: TokenCounts): TokenCounts {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined)) as TokenCounts;
}

/**
 * The token figures a prompt response carries: ACP's `usage` (the main figure) and the
 * per-model rows both adapters attach under `_meta.quota.model_usage`. The dollar figure
 * Claude Code sends is never read.
 */
export function genericTurnReport(response: unknown): TurnReport | undefined {
  if (!response || typeof response !== "object") return undefined;
  const { usage, _meta } = response as { usage?: Record<string, unknown> | null; _meta?: { quota?: { model_usage?: unknown } } | null };
  const report: { main?: TokenCounts; models?: { model: string; counts: TokenCounts }[] } = {};
  if (usage && typeof usage === "object") {
    report.main = defined({
      input: count(usage.inputTokens),
      cacheRead: count(usage.cachedReadTokens),
      cacheWrite: count(usage.cachedWriteTokens),
      output: count(usage.outputTokens),
      reasoning: count(usage.thoughtTokens),
      total: count(usage.totalTokens)
    });
  }
  const rows = _meta?.quota?.model_usage;
  if (Array.isArray(rows)) {
    report.models = rows.flatMap((row) => {
      const { model, token_count: tokens } = (row ?? {}) as { model?: unknown; token_count?: Record<string, unknown> };
      if (typeof model !== "string" || !model.trim() || !tokens || typeof tokens !== "object") return [];
      const counts = defined({
        input: count(tokens.inputTokens),
        cacheRead: count(tokens.cachedInputTokens),
        cacheWrite: count(tokens.cachedWriteTokens ?? tokens.cacheWriteInputTokens),
        output: count(tokens.outputTokens),
        reasoning: count(tokens.reasoningOutputTokens),
        total: count(tokens.totalTokens),
      });
      return [{ model, counts }];
    });
  }
  return report.main || report.models?.length ? report : undefined;
}
