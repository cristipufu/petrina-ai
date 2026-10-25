import { afterAll, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep } from "@petrina/core";

import { executionFor } from "@petrina/orchestrator";

import { changesOf } from "../../../src/repositories.js";
import { ReviewResult } from "../../../src/roles.js";
import { checkReviewEvidence } from "@petrina/core";
import { git } from "../../fixtures.js";

import { continuedReviewFixtures } from "../../fixtures/continued-review.js";
const { COVERED, signal, important, rounds, passedCovered, close } = continuedReviewFixtures();
afterAll(close);

for (const [later, builder] of [["security-reviewer", "builder"], ["added-privacy-reviewer", "saved-caretaker"]] as const) it(`passes a later ${later === "security-reviewer" ? "security" : "added"} review over the covered finding, and finds a ${builder === "builder" ? "built-in" : "task-owned"} Builder by its result for a new one`, async () => {
  for (const fresh of [false, true]) {
    const f = await rounds({ later, builder });
    try {
      if (later !== "security-reviewer") f.engine.s.roles.push({ ...f.engine.s.roles.find((role) => role.id === "security-reviewer")!, id: later, name: "Privacy reviewer", added: true });
      f.task.findings = [important("accepted")];
      await f.exhaust();
      const decided = structuredClone(f.task.reviewDecision!);
      expect(decided).toEqual({ stageId: "review", round: 1, accepted: true, covers: ["accepted"], at: expect.any(Number), versions: await changesOf(f.task) });
      const kept = structuredClone(f.task.findings[0]!);
      expect(await f.review(fresh ? { verdict: "fail", findings: [{ text: "Anyone can read the greeting", severity: "important", evidence: "Opened it signed out" }] } : { verdict: "pass" })).toBe("continue");
      expect(f.task.findings[0]).toEqual(kept);
      expect(f.task.reviewDecision).toEqual(decided);
      if (!fresh) {
        expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("test");
        expect(f.step().reason).toBe(COVERED);
        expect(f.task.rounds.security).toBeUndefined();
        continue;
      }
      // Exactly as today: back to the Builder, found by its result, with everything open counted.
      expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.security).toBe(2);
      expect(f.step().reason).toBe("sent back: 2 important");
      // Its rounds then run out on unchanged work: a new decision covers everything open.
      f.task.fixing = false;
      expect(await f.review({ verdict: "pass" })).toBe("stop");
      expect(f.task.reviewDecision).toEqual({ stageId: "security", round: 2, accepted: false, covers: ["accepted", f.task.findings[1]!.id], at: expect.any(Number), versions: decided.versions });
      expect(f.open()).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  }
});

it("puts a covered finding back on the usual route when a later reviewer reproduces it, while naming it bare or confirming another finding does not", async () => {
  for (const confirmed of ["nit", "bare", "second"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("first"), important("second"), important("nit", { severity: "suggestion" })];
      const bare = ReviewResult.parse({ verdict: "pass", confirms: ["second"] });
      // Before any decision to continue, an open finding may still be confirmed by id alone.
      if (confirmed === "bare") expect(checkReviewEvidence(f.task.findings, bare, f.task)).toBeUndefined();
      await f.exhaust();
      expect(f.task.reviewDecision!.covers).toEqual(["first", "second"]);
      if (confirmed === "bare") {
        // Once it is covered, a bare id is not a reproduction: the reviewer is asked for current evidence or to drop it.
        expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("Current evidence is required");
        expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("second");
        // Controls: a finding the decision does not list, and a decision saved before covers were recorded.
        expect(checkReviewEvidence(f.task.findings, ReviewResult.parse({ verdict: "pass", confirms: ["nit"] }), f.task)).toBeUndefined();
        expect(checkReviewEvidence(f.task.findings, bare, { reviewDecision: { stageId: "review", round: 1, accepted: true } })).toBeUndefined();
      }
      const reproduced = { id: confirmed === "bare" ? "second" : confirmed, evidence: `On current code, ${confirmed} still fails; the signed-in control passes.` };
      const result = await f.review({ verdict: confirmed === "second" ? "fail" : "pass", confirms: [confirmed === "bare" ? "second" : reproduced] });
      expect(result).toBe("continue");
      // Even a bare id that got past the check leaves the cover alone.
      if (confirmed !== "second") {
        expect(passedCovered(f.task)).toBe(true);
        expect(f.step().reason).toBe("review passed; 2 earlier important still open under your decision to continue");
        expect(f.task.findings.every((finding) => finding.reproducedAt === undefined)).toBe(true);
        continue;
      }
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      expect(f.task.findings.map((finding) => finding.reproducedAt !== undefined)).toEqual([false, true, false]);
      expect(f.task.findings[1]!.status).toBe("open");
    } finally { await f.engine.shutdown(); }
  }
});

it("judges cover by the task's own change: main moving alone keeps it, a change or an unreadable version ends it", async () => {
  for (const what of ["main", "edit", "unreadable"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("accepted")];
      await f.exhaust();
      const scope = executionFor(f.task);
      if (what === "main") {
        writeFileSync(join(f.owners[0]!.repo, "incoming.txt"), "main moved\n");
        await git(f.owners[0]!.repo, "add", "."); await git(f.owners[0]!.repo, "commit", "-q", "-m", "Main advances");
        expect(await f.engine["updates"].upToDate(scope, signal())).toBe("moved");
      } else if (what === "edit") await f.commit();
      else delete scope.work.baseSha;
      expect(await f.review()).toBe("continue");
      if (what === "main") expect(passedCovered(f.task)).toBe(true);
      else { expect(f.task.fixing).toBe(true); expect(f.step().reason).toBe("sent back: 1 important"); }
    } finally { await f.engine.shutdown(); }
  }
});

it("ends the cover of an acceptance finding that fails again, and keeps final acceptance on its own route", async () => {
  for (const again of [true, false]) {
    const f = await rounds({ tested: true });
    const text = "The greeting shows on the welcome page";
    const reply = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
      const value = schema.parse({ summary: "Tried it", checks: [{ text, result: again ? "fail" : "pass", evidence: again ? "Still missing for guests; signed-in control shows it" : "Shown" }], proofAnswers: [] });
      options?.used?.(profileId);
      beginAgentStep(scope.task, roleId, profileId, Date.now(), f.engine.s.roles, undefined, scope.work);
      return value;
    });
    try {
      f.task.brief = { summary: "Show a greeting", areas: [], forUsers: [], risks: [], acceptance: [{ text, met: false, verification: "failed" }] };
      f.task.findings = [important("acceptance", { text: `Failed acceptance check: ${text}`, raisedBy: "opus-high", confirmedBy: [] })];
      await f.exhaust();
      await f.after();
      // Acceptance testing after the decision, before the later review.
      f.task.stageIndex = 2;
      await f.engine["work"].runDo(executionFor(f.task), f.stageOf("test"), signal());
      expect(f.task.findings[0]!.reproducedAt !== undefined).toBe(again);
      expect(f.task.findings[0]!.status).toBe(again ? "open" : "fixed");
      expect(await f.review()).toBe("continue");
      if (!again) { expect(passedCovered(f.task)).toBe(true); continue; }
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      // Final acceptance failing again goes back to the Builder within its own allowance, never marked fixed.
      f.task.fixing = false; f.task.retest = true; f.task.stageIndex = 2;
      await f.engine["work"].runDo(executionFor(f.task), f.stageOf("test"), signal());
      expect(f.task.stageIndex).toBe(0); expect(executionFor(f.task).work.acceptanceReturns).toBe(1);
      expect(f.task.findings[0]!.status).toBe("open");
    } finally { reply.mockRestore(); await f.engine.shutdown(); }
  }
});
