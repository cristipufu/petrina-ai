import { describe, expect, it } from "bun:test";
import type { Finding } from "@petrina/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, recordDisputes } from "../src/engine.js";
import { BriefResult, ReviewResult } from "../src/roles.js";
import { describeTool, isPlumbing } from "../src/acp-run.js";

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

  it("refuses a blank answer to an objection", () => {
    const brief = { summary: "A greeting.", acceptance: ["A greeting file exists"] };
    expect(BriefResult.safeParse({ ...brief, answers: [{ id: "o1", status: "accepted", answer: "  " }] }).success).toBe(false);
    expect(BriefResult.safeParse({ ...brief, answers: [{ id: "o1", status: "accepted", answer: "Added the empty state." }] }).success).toBe(true);
  });

  it("refuses a change request for a check that is no longer waiting, so the window keeps the note", () => {
    const dir = mkdtempSync(join(tmpdir(), "petrina-changes-"));
    const engine = new Engine(dir);
    try {
      expect(() => engine.requestChanges("inbox-gone", "Make it friendlier")).toThrow("isn't waiting any more");
    } finally {
      engine.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says what a command is for, and hides the tools' own plumbing", () => {
    expect(describeTool({ kind: "execute", rawInput: { command: "rg -n stage src", description: "find where the engine records stage changes" } })).toBe("Find where the engine records stage changes");
    expect(describeTool({ kind: "execute", rawInput: { command: "bun test" } })).toBe("Running the tests");
    expect(isPlumbing({ kind: "other", title: "ToolSearch" })).toBe(true);
    expect(isPlumbing({ kind: "other", title: "TodoWrite" })).toBe(true);
    expect(isPlumbing({ kind: "read", title: "Read notes.txt" })).toBe(false);
  });
});
