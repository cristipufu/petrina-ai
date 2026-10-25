import { NOW, MIN, HOUR } from "../../fixtures/analytics.js";
import { describe, expect, it } from "vitest";

import { agoText, atLeastLine, codexLimits, durationText, figureText, limitWords, nearestLimit, tokensText } from "../../../src/numbers.js";

describe("Words", () => {
  it("reads numbers in plain language", () => {
    expect(tokensText(820)).toBe("820 tokens");
    expect(tokensText(48_200)).toBe("48k tokens");
    expect(tokensText(1_900_000)).toBe("1.9M tokens");
    expect(durationText(40_000)).toBe("under a minute");
    expect(durationText(12 * MIN)).toBe("12m");
    expect(durationText(65 * MIN)).toBe("1h 05m");
    expect(durationText(312 * HOUR + 20 * MIN)).toBe("312h");
    expect(figureText({ value: 48_000, atLeast: true }, "tokens")).toBe("at least 48k tokens");
    expect(figureText({ atLeast: false }, "time")).toBe("not reported");
    expect(atLeastLine({ noTokens: 2, lost: 1, beforeTracking: true })).toBe(
      "“At least” because 2 turns sent no token report, 1 turn was cut off when Petrina stopped and work from before Petrina started keeping track isn't counted.",
    );
  });

  it("words limits with when they were reported, and never shows an old percentage as current", () => {
    const limit = { toolId: "claude-code", kind: "seven_day_opus", status: "allowed_warning" as const, utilization: 0.83, resetsAt: NOW + 2 * HOUR, at: NOW - 5 * MIN };
    expect(limitWords(limit, NOW)).toMatchObject({ used: "83% used · provider warning", status: "fine", reported: "reported 5m ago", stale: false });
    // Petrina's near-limit mark applies to the measured share before rounding, whatever status reported it.
    expect(limitWords({ ...limit, utilization: 0.895 }, NOW)).toMatchObject({ used: "90% used · provider warning", status: "fine" });
    for (const status of ["allowed", "allowed_warning"] as const) expect(limitWords({ ...limit, status, utilization: 0.9 }, NOW)).toMatchObject({ used: "90% used · close to the limit", status: "close" });
    expect(limitWords({ ...limit, utilization: 0 }, NOW)).toMatchObject({ used: "0% used · provider warning", percent: 0 });
    const { utilization: _unknown, ...unmeasured } = limit;
    expect(limitWords(unmeasured, NOW)).toMatchObject({ used: "provider warning · percentage not reported", status: "fine" });
    expect(limitWords(unmeasured, NOW).percent).toBeUndefined();
    expect(nearestLimit([unmeasured, { ...limit, kind: "five_hour", status: "allowed", utilization: 0.1 }], "claude-code", NOW)?.kind).toBe("five_hour");
    expect(limitWords(limit, NOW).resets).toMatch(/^resets today \d\d:\d\d$/);
    expect(limitWords(limit, NOW + 3 * HOUR)).toMatchObject({ used: "has reset since it was last reported", stale: true });
    const { resetsAt: _reset, ...withoutReset } = { ...limit, at: NOW - HOUR };
    expect(limitWords(withoutReset, NOW)).toMatchObject({ used: "not reported", stale: true });
    expect(nearestLimit([withoutReset], "claude-code", NOW)).toBeUndefined();
    expect(limitWords({ toolId: "codex", kind: "primary", status: "allowed", at: NOW }, NOW).used).toBe("not reported");
    expect(limitWords({ ...limit, kind: "five_hour", status: "rejected" }, NOW)).toMatchObject({ label: "5-hour", status: "reached", used: "83% used · limit reached" });
    expect(agoText(NOW - 3 * HOUR, NOW)).toBe("3h ago");
  });

  it("reads Codex's limits, keeping only percentages, lengths and resets", () => {
    const limits = codexLimits(
      {
        rateLimits: { limitId: "codex", primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 } },
        rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 }, secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt: Math.round(NOW / 1000) + 3600 }, planType: "pro" } },
        accountId: "secret-account",
      },
      NOW,
    );
    expect(limits).toEqual([
      { toolId: "codex", kind: "codex:primary", windowMinutes: 10_080, at: NOW, utilization: 0.16, status: "allowed", resetsAt: 1_792_673_339_000 },
      { toolId: "codex", kind: "codex:secondary", windowMinutes: 300, at: NOW, utilization: 0.91, status: "allowed_warning", resetsAt: (Math.round(NOW / 1000) + 3600) * 1000 },
    ]);
    expect(JSON.stringify(limits)).not.toContain("secret");
    expect(nearestLimit(limits, "codex", NOW)?.kind).toBe("codex:secondary");
    expect(codexLimits(undefined, NOW)).toEqual([]);
  });
});
