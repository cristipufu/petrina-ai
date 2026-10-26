import { expect, it } from "vitest";
import { checkReviewEvidence } from "@petrina/core";
import { continuedReviewFixture, COVERED, important, passedCovered, report } from "../../fixtures/continued-review.js";

for (const [later, builder] of [["security-reviewer", "builder"], ["added-privacy-reviewer", "saved-caretaker"]] as const) it(`passes a later ${later === "security-reviewer" ? "security" : "added"} review over the covered finding, and finds a ${builder === "builder" ? "built-in" : "task-owned"} Builder by its result for a new one`, async () => {
  for (const fresh of [false, true]) {
    const f = continuedReviewFixture({ later, builder });
    f.task.findings = [important("accepted")];
    await f.exhaust();
    const decided = structuredClone(f.task.reviewDecision!);
    expect(decided).toEqual({ stageId: "review", round: 1, accepted: true, covers: ["accepted"], at: f.clock.now(), versions: f.changes() });
    const kept = structuredClone(f.task.findings[0]!);
    expect(await f.review(report(fresh ? { verdict: "fail", findings: [{ text: "Anyone can read the greeting", severity: "important", evidence: "Opened it signed out" }] } : {}))).toBe("continue");
    expect(f.task.findings[0]).toEqual(kept); expect(f.task.reviewDecision).toEqual(decided);
    if (!fresh) {
      expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("test"); expect(f.step().reason).toBe(COVERED); expect(f.task.rounds.security).toBeUndefined();
      continue;
    }
    expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.security).toBe(2);
    expect(f.step().reason).toBe("sent back: 2 important");
    f.task.fixing = false;
    expect(await f.review()).toBe("stop");
    expect(f.task.reviewDecision).toEqual({ stageId: "security", round: 2, accepted: false, covers: ["accepted", f.task.findings[1]!.id], at: f.clock.now(), versions: decided.versions });
    expect(f.open()).toHaveLength(1);
  }
});

it("puts a covered finding back on the usual route when a later reviewer reproduces it, while naming it bare or confirming another finding does not", async () => {
  for (const confirmed of ["nit", "bare", "second"] as const) {
    const f = continuedReviewFixture(); f.task.findings = [important("first"), important("second"), important("nit", { severity: "suggestion" })];
    const bare = report({ confirms: ["second"] });
    if (confirmed === "bare") expect(checkReviewEvidence(f.task.findings, bare, f.task)).toBeUndefined();
    await f.exhaust(); expect(f.task.reviewDecision!.covers).toEqual(["first", "second"]);
    if (confirmed === "bare") {
      expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("Current evidence is required");
      expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("second");
      expect(checkReviewEvidence(f.task.findings, report({ confirms: ["nit"] }), f.task)).toBeUndefined();
      expect(checkReviewEvidence(f.task.findings, bare, { reviewDecision: { stageId: "review", round: 1, accepted: true } })).toBeUndefined();
    }
    const id = confirmed === "bare" ? "second" : confirmed;
    const value = report({ verdict: confirmed === "second" ? "fail" : "pass", confirms: [id],
      ...(confirmed !== "bare" ? { confirmationEvidence: { [id]: `On current code, ${confirmed} still fails; the signed-in control passes.` } } : {}) });
    expect(await f.review(value)).toBe("continue");
    if (confirmed !== "second") {
      expect(passedCovered(f.task)).toBe(true); expect(f.step().reason).toBe("review passed; 2 earlier important still open under your decision to continue");
      expect(f.task.findings.every(finding => finding.reproducedAt === undefined)).toBe(true); continue;
    }
    expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
    expect(f.task.findings.map(finding => finding.reproducedAt !== undefined)).toEqual([false, true, false]); expect(f.task.findings[1]!.status).toBe("open");
  }
});

it("sends an unchanged finding back as today without a decision to continue, after asking for changes, or with a decision saved before covers", async () => {
  for (const how of ["none", "changes", "older"] as const) {
    const f = continuedReviewFixture(); f.task.findings = [important("accepted")];
    if (how === "none") f.task.stageIndex = 2; else await f.exhaust(how === "changes" ? "changes" : "continue");
    if (how === "changes") { expect(f.task.reviewDecision).toBeUndefined(); expect(f.task.fixing).toBe(true); f.task.fixing = false; }
    if (how === "older") f.task.reviewDecision = { stageId: "review", round: 1, accepted: true };
    expect(await f.review()).toBe("continue"); expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0); expect(f.step().reason).toBe("sent back: 1 important");
  }
});

it("judges shared cover per finding's products and repairs only the owners of findings it does not cover", async () => {
  for (const moved of ["api", "shop"] as const) {
    const f = continuedReviewFixture({ shared: true }), [shop, api] = f.task.repositories!.map(work => work.productId) as [string, string];
    f.task.findings = [important("accepted", { productIds: [shop] })]; await f.exhaust();
    expect(Object.keys(f.task.reviewDecision!.versions!).sort()).toEqual([shop, api].sort()); f.observeChange(moved === "api" ? 1 : 0);
    if (moved === "api") { expect(await f.review()).toBe("continue"); expect(passedCovered(f.task)).toBe(true); }
    expect(await f.review(report({ verdict: "fail", findings: [{ text: "The API leaks the greeting", productIds: [api], severity: "important", evidence: "Read it signed out" }] }))).toBe("continue");
    expect(f.task.repair).toEqual(expect.objectContaining({ products: moved === "api" ? [api] : [shop, api], kind: "review" }));
    expect(f.task.repositories!.map(work => [work.acceptanceReturns, work.checkReturns])).toEqual([[undefined, undefined], [undefined, undefined]]); expect(f.task.findings[0]!.status).toBe("open");
  }
});

for (const observation of ["same-change", "changed", "unreadable"] as const) it(`uses the actual own-change observation when review cover is ${observation}`, async () => {
  const f = continuedReviewFixture(); f.task.findings = [important("accepted")]; await f.exhaust();
  if (observation === "changed") f.observeChange(); else if (observation === "unreadable") f.observeUnreadable();
  expect(await f.review()).toBe("continue");
  if (observation === "same-change") expect(passedCovered(f.task)).toBe(true);
  else { expect(f.task.fixing).toBe(true); expect(f.step().reason).toBe("sent back: 1 important"); }
});

it("ends the cover of an acceptance finding that fails again, and keeps final acceptance on its own route", async () => {
  for (const again of [true, false]) {
    const f = continuedReviewFixture({ tested: true }), text = "The greeting shows on the welcome page";
    f.task.brief = { summary: "Show a greeting", areas: [], forUsers: [], risks: [], acceptance: [{ text, met: false, verification: "failed" }] };
    f.task.findings = [important("acceptance", { text: `Failed acceptance check: ${text}`, raisedBy: "opus-high", confirmedBy: [] })];
    await f.exhaust(); await f.acceptance(again, text);
    expect(f.task.findings[0]!.reproducedAt !== undefined).toBe(again); expect(f.task.findings[0]!.status).toBe(again ? "open" : "fixed");
    expect(await f.review()).toBe("continue");
    if (!again) { expect(passedCovered(f.task)).toBe(true); continue; }
    expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
    f.task.fixing = false; f.task.retest = true;
    await f.acceptance(again, text);
    expect(f.task.stageIndex).toBe(0); expect(f.scope.work.acceptanceReturns).toBe(1); expect(f.task.findings[0]!.status).toBe("open");
  }
});
