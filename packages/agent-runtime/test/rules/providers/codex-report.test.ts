import { describe, expect, it } from "bun:test";
import { nearestLimit } from "@petrina/core";
import { codexLimits } from "../../../src/codex-report.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

describe("codexLimits", () => {
  it("reads Codex's limits, keeping only percentages, lengths and resets", () => {
    const limits = codexLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 },
            secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt: Math.round(NOW / 1000) + 3600 },
            planType: "pro",
          },
        },
        accountId: "secret-account",
      },
      NOW,
    );
    expect(limits).toEqual([
      {
        toolId: "codex",
        kind: "codex:primary",
        windowMinutes: 10_080,
        at: NOW,
        utilization: 0.16,
        status: "allowed",
        resetsAt: 1_792_673_339_000,
      },
      {
        toolId: "codex",
        kind: "codex:secondary",
        windowMinutes: 300,
        at: NOW,
        utilization: 0.91,
        status: "allowed_warning",
        resetsAt: (Math.round(NOW / 1000) + 3600) * 1000,
      },
    ]);
    expect(JSON.stringify(limits)).not.toContain("secret");
    expect(nearestLimit(limits, "codex", NOW)?.kind).toBe("codex:secondary");
    expect(codexLimits(undefined, NOW)).toEqual([]);
  });
});
