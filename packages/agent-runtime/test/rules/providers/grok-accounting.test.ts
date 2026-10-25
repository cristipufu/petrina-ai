import { expect, it } from "bun:test";
import { turnTokens } from "@petrina/core";
import { grokTurnReport } from "../../../src/grok-report.js";
  it("counts all model calls once and separates cached input without counting thinking twice", () => {
    // Observed from the installed CLI: 12 model calls, not just its final response.
    const counts = { inputTokens: 663075, outputTokens: 28494, cachedReadTokens: 577024, cacheCreationTokens: 0, reasoningTokens: 26708, totalTokens: 691569 };
    const report = grokTurnReport({ _meta: { totalTokens: 500000, inputTokens: 100, outputTokens: 5, usage: { ...counts, modelUsage: { "grok-4.7-build": counts } } } });
    const result = turnTokens({ toolId: "grok", report });
    expect(result.tokens).toEqual({ input: 86051, cacheRead: 577024, cacheWrite: 0, output: 28494, reasoning: 26708, total: 691569 });
    expect(result.lines).toEqual([{ model: "grok-4.7-build", ...result.tokens }]);
    expect(result.mainOnly).toBe(false);
    expect(report?.model).toBe("grok-4.7-build");
  });


it("preserves an explicitly reported zero-token Grok turn", () => {
  expect(grokTurnReport({ _meta: { usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 } } })?.main?.total).toBe(0);
});
