import { expect, it } from "bun:test";
import { antigravityReading, antigravityTurnReport } from "../../../src/antigravity-report.js";
import { quota } from "../../fixtures/antigravity-quota.js";

  it("reads real cached session reports and counts only the resumed turn's input and cache once", () => {
    const zero = antigravityReading("- **Session total:** data not available yet");
    const first = antigravityReading("- **Session total:** 180,323 tokens (prompt: 176,179, completion: 2,096, thinking: 2,048, cached: 140,391)");
    const second = antigravityReading("- **Session total:** 180,443 tokens (prompt: 176,279, completion: 2,106, thinking: 2,058, cached: 140,471)");
    expect(antigravityTurnReport(zero, first)).toEqual({ main: { total: 180323, input: 35788, cacheRead: 140391, output: 4144, reasoning: 2048 } });
    expect(antigravityTurnReport(first, second)).toEqual({ main: { total: 120, input: 20, cacheRead: 80, output: 20, reasoning: 10 } });
    expect(antigravityTurnReport(second, first)).toBeUndefined();
    expect(antigravityReading("- **Session total:** 1,973,940 tokens (prompt: 1,960,955, completion: 10,558, thinking: 2,427, cached: 1,716,149)").tokens?.total).toBe(1973940);
    const unknownCache = antigravityReading("- **Session total:** 180,323 tokens (prompt: 176,179, completion: 2,096, thinking: 2,048)");
    expect(antigravityTurnReport(unknownCache, second)).toEqual({ main: { total: 120, output: 20, reasoning: 10 } });
    expect(antigravityReading("- **Session total:** 10 tokens (prompt: 8, completion: 2, cached: 9)").tokens).toBeUndefined();
    const decreasing = { ...second, tokens: { ...second.tokens!, cached: 1 } };
    expect(antigravityTurnReport(first, decreasing)?.main?.cacheRead).toBeUndefined();
  });

  it("reads the native quota groups and explicit UTC resets, without blocking Gemini for unavailable third-party models", () => {
    const reading = antigravityReading(quota);
    expect(reading.tokens).toEqual({ total: 26682, input: 26645, output: 37, reasoning: 33 });
    expect(reading.reports).toEqual([
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "seven_day", utilization: 0, status: "allowed", resetsAt: Date.parse("2026-10-26T16:50Z") },
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "five_hour", utilization: 0.2, status: "allowed", resetsAt: Date.parse("2026-10-19T21:50Z") },
      { toolId: "antigravity", model: "argon", name: "Gemini 4 Argon", kind: "seven_day", utilization: 0.98, status: "allowed_warning", resetsAt: Date.parse("2026-10-26T17:33Z") },
    ]);
    expect(antigravityReading(quota.replace(/- \*\*Gemini 4 Argon\*\*[\s\S]*/, "")).reports[0]?.model).toBe("gemini");
    expect(antigravityReading(quota.replace("2% remaining", "0% remaining")).reports.at(-1)?.status).toBe("rejected");
    expect(antigravityReading(quota.replaceAll(/resets [^)]+/g, "resets invalid")).reports).toEqual([]);
    expect(antigravityReading("context: 500000 tokens")).toEqual({ reports: [] });
    // Native /usage reports unused shared windows alongside a separately consumed Argon quota.
    const separate = antigravityReading(quota.replace("80% remaining", "100% remaining").replace("2% remaining", "37% remaining")).reports;
    expect(separate.map(report => [report.model, report.kind, report.utilization])).toEqual([
      ["flash", "seven_day", 0], ["flash", "five_hour", 0], ["argon", "seven_day", 0.63],
    ]);
  });

  it("uses differences across turns and resume, includes thinking once in output, and leaves cache/new input unknown", () => {
    const zero = antigravityReading("- **Session total:** data not available yet");
    const first = antigravityReading(quota);
    const second = antigravityReading(quota.replace("26,682", "26,797").replace("26,645", "26,745").replace("completion: 4", "completion: 9").replace("thinking: 33", "thinking: 43"));
    expect(antigravityTurnReport(zero, first)).toEqual({ main: { total: 26682, output: 37, reasoning: 33 } });
    expect(antigravityTurnReport(first, second)).toEqual({ main: { total: 115, output: 15, reasoning: 10 } });
    expect(antigravityTurnReport(second, first)).toBeUndefined();
    expect(antigravityTurnReport(undefined, first)).toBeUndefined();
    expect(antigravityReading(quota.replace("26,682", "999" )).tokens).toBeUndefined();
  });

  it("reads agy --print /usage TSV quota rows alongside session usage totals", () => {
    const tsv = [
      "Model\tQuota\tRemaining\tResets",
      "Gemini Models\tWeekly Limit Remaining\t30%\t2026-11-03T12:56:49Z",
      "Gemini Models\t5-Hour Limit Remaining\t80%\t2026-10-31T13:56:49Z",
      "Gemini 4 Argon\tWeekly Limit Remaining\t2%\t2026-11-03T17:33:00Z",
      "Claude Opus\tWeekly Limit Remaining\t0%\t2026-11-03T12:00:00Z",
      "",
      "- **Session total:** 203,958 tokens (prompt: 203,808, completion: 15, thinking: 135, cached: 200,660)",
    ].join("\n");
    const zero = antigravityReading("- **Session total:** data not available yet");
    const reading = antigravityReading(tsv);
    expect(reading.tokens).toEqual({
      total: 203958,
      input: 203808,
      cached: 200660,
      output: 150,
      reasoning: 135,
    });
    expect(antigravityTurnReport(zero, reading)).toEqual({
      main: { total: 203958, input: 3148, cacheRead: 200660, output: 150, reasoning: 135 },
    });
    expect(reading.reports).toEqual([
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "seven_day", utilization: 0.7, status: "allowed", resetsAt: Date.parse("2026-11-03T12:56:49Z") },
      { toolId: "antigravity", model: "flash", name: "Gemini Models", kind: "five_hour", utilization: 0.2, status: "allowed", resetsAt: Date.parse("2026-10-31T13:56:49Z") },
      { toolId: "antigravity", model: "argon", name: "Gemini 4 Argon", kind: "seven_day", utilization: 0.98, status: "allowed_warning", resetsAt: Date.parse("2026-11-03T17:33:00Z") },
    ]);
  });
