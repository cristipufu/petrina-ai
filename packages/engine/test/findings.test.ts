import { describe, expect, it } from "bun:test";
import type { Finding } from "@petrina/core";
import { recordDisputes } from "../src/engine.js";
import { ReviewResult } from "../src/prompts.js";

const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy: "sol-xhigh", confirmedBy: [], status: "open", ...extra });

describe("disputed findings", () => {
  it("keeps who disputed a finding and why, and dismisses it only when nobody else backed it", () => {
    const findings = [finding("a"), finding("b", { confirmedBy: ["opus-high"] }), finding("c", { raisedBy: "petrina" })];
    recordDisputes(findings as never, [
      { id: "a", reason: "The test it names passes on main; the failure was a flaky run." },
      { id: "b", reason: "I could not reproduce this on the branch." },
      { id: "c", reason: "This test was renamed, not deleted." },
    ], "opus-xhigh", 1);
    expect(findings[0]!.status).toBe("dismissed");
    expect(findings[0]!.disputes).toEqual([{ by: "opus-xhigh", reason: "The test it names passes on main; the failure was a flaky run.", at: 1 }]);
    // Confirmed by another reviewer, and Petrina's own check: both stay open, with the dispute shown.
    expect(findings[1]!.status).toBe("open");
    expect(findings[1]!.disputes).toHaveLength(1);
    expect(findings[2]!.status).toBe("open");
  });

  it("refuses a dispute without a reason", () => {
    expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: ["a"] }).success).toBe(false);
    expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: [{ id: "a", reason: "" }] }).success).toBe(false);
    expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: [{ id: "a", reason: "Not reproducible on the branch." }] }).success).toBe(true);
  });
});
