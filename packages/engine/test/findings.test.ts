import { describe, expect, it } from "bun:test";
import type { Finding } from "@petrina/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { recordDisputes } from "../src/engine.js";
import { BriefResult, ReviewResult } from "../src/roles.js";
import { addEvidence, checkReviewEvidence } from "../src/review.js";
import { describeTool, isPlumbing } from "../src/tool-activity.js";

const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy: "sol-xhigh", confirmedBy: [], status: "open", ...extra });

describe("disputed findings", () => {
  it("keeps independent evidence once when earlier proofs are repeated, without dropping overlapping new details", () => {
    const first = "Dispute before confirmation dismisses it.\n\nThe reverse order leaves it open.";
    const second = "Dismiss then independently confirm: expected open, observed dismissed.";
    const record = finding("a", { evidence: first });
    addEvidence(record as never, second);
    const combined = `${first}\n\n${second}`;
    expect(record.evidence).toBe(combined);
    for (const repeated of [first, second, `  ${first}  `]) {
      addEvidence(record as never, repeated);
      expect(record.evidence).toBe(combined);
    }
    // A phrase shared with an existing proof is not an identical block of evidence.
    const overlapping = "independently confirm";
    addEvidence(record as never, overlapping);
    expect(record.evidence).toBe(`${combined}\n\n${overlapping}`);
    const extended = `${first} Reloading still leaves it dismissed.`;
    addEvidence(record as never, extended);
    const all = `${combined}\n\n${overlapping}\n\n${extended}`;
    expect(record.evidence).toBe(all);
    // Once surrounded by other proofs, this one is still retained only once.
    addEvidence(record as never, second);
    expect(record.evidence).toBe(all);
  });

  it("normalizes current evidence while preserving legacy open confirmations", () => {
    const result = ReviewResult.parse({ verdict: "fail", confirms: ["open", { id: "fixed", evidence: "  A new ordering fails on this version.  " }] });
    expect(result.confirms).toEqual(["open", "fixed"]);
    expect(result.confirmationEvidence).toEqual({ fixed: "A new ordering fails on this version." });
    expect(checkReviewEvidence([finding("open"), finding("fixed", { status: "fixed", answer: { fixed: true, text: "Fixed the previous ordering", at: 1 } })], result)).toBeUndefined();
    expect(ReviewResult.safeParse({ verdict: "fail", confirms: [{ id: "fixed", evidence: "   " }] }).success).toBe(false);
  });

  it("requires evidence for an explicit reopening without inferring identity from a new report's wording", () => {
    const fixed = finding("fixed", { status: "fixed", evidence: "Old case", answer: { fixed: true, text: "Fixed the previous ordering", at: 1 } });
    const before = JSON.stringify(fixed);
    expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", confirms: [fixed.id] }))).toContain("Current evidence is required");
    expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", findings: [{ text: fixed.text, severity: "important" }] }))).toBeUndefined();
    expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", findings: [{ text: fixed.text, severity: "important", evidence: "A different current case fails." }] }))).toBeUndefined();
    expect(JSON.stringify(fixed)).toBe(before);
    expect(checkReviewEvidence([finding("open")], ReviewResult.parse({ verdict: "fail", confirms: ["open"] }))).toBeUndefined();
    expect(checkReviewEvidence([finding("native", { raisedBy: "petrina", status: "fixed" })], ReviewResult.parse({ verdict: "fail", confirms: ["native"] }))).toBeUndefined();
  });

  it("requires fresh proof for dismissed and already reopened reports without reviving a historical id", () => {
    for (const earlier of [finding("dismissed", { status: "dismissed", evidence: "The original case passed." }), finding("reopened", { reopenedAt: 1, evidence: "A new current case fails." })]) {
      const before = JSON.stringify(earlier);
      expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", confirms: [earlier.id] }))).toContain("Current evidence is required");
      expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", findings: [{ text: earlier.text, severity: "important" }] }))).toBeUndefined();
      expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", confirms: [{ id: earlier.id, evidence: "A different current path fails; the original path still passes." }] }))).toBeUndefined();
      expect(JSON.stringify(earlier)).toBe(before);
    }
  });

  it("refuses agreement with ids absent from the saved blind review input", () => {
    expect(checkReviewEvidence([finding("known")], ReviewResult.parse({ verdict: "fail", confirms: ["peer-not-shown"] }))).toContain("not shown");
    expect(checkReviewEvidence([finding("known")], ReviewResult.parse({ verdict: "pass", disputes: [{ id: "peer-not-shown", reason: "The current code handles this case." }] }))).toContain("not shown");
  });

  it("keeps who disputed a finding and why without settling it before other reviewers report", () => {
    const findings = [finding("a"), finding("b", { confirmedBy: ["opus-high"] }), finding("c", { raisedBy: "petrina" })];
    recordDisputes(findings as never, [
      { id: "a", reason: "The test it names passes on main; the failure was a flaky run." },
      { id: "b", reason: "I could not reproduce this on the branch." },
      { id: "c", reason: "This test was renamed, not deleted." },
    ], "opus-xhigh", 1);
    expect(findings[0]!.status).toBe("open");
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

  it("refuses a change request for a check that is no longer waiting, so the window keeps the note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petrina-changes-"));
    const engine = new Engine(dir);
    try {
      expect(() => engine.requestChanges("inbox-gone", "Make it friendlier")).toThrow("isn't waiting any more");
    } finally {
      await engine.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says what a command is for, and hides the tools' own plumbing", () => {
    expect(describeTool({ kind: "execute", rawInput: { command: "rg -n stage src", description: "find where the engine records stage changes" } })).toBe("Find where the engine records stage changes");
    expect(describeTool({ kind: "execute", rawInput: { command: "bun test" } })).toBe("Running the tests");
    // Only the file's name, however the tool writes its path.
    expect(describeTool({ kind: "edit", locations: [{ path: "/Users/ana/shop/notes.txt" }] })).toBe("Editing notes.txt");
    expect(describeTool({ kind: "edit", locations: [{ path: "C:\\Users\\ana\\shop\\notes.txt" }] })).toBe("Editing notes.txt");
    expect(isPlumbing({ kind: "other", title: "ToolSearch" })).toBe(true);
    expect(isPlumbing({ kind: "other", title: "TodoWrite" })).toBe(true);
    expect(isPlumbing({ kind: "read", title: "Read notes.txt" })).toBe(false);
  });
});
