import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { checkReviewEvidence } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { ReviewResult } from "../../../src/roles.js";
import { reviewRecords } from "../../fixtures/review-records.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


function fixture(owner: EngineCaseOwner) {
  const root = mkdtempSync(join(owner.root, "petrina-review-recording-"));
  return reviewRecords(owner, root);
}
const proof = "The current guest state fails after signing out; the signed-in control and original case pass.";

it("normalizes current proof into the real report recorder and keeps its finding and verdict after restart", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner), { task, stage, first, second } = f;
    let engine = f.engine;
    try {
      task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 }; task.rounds[stage.id] = 2;
      task.findings = [{ id: "closed", text: "The greeting is missing.", productIds: [second, first], severity: "blocking", status: "fixed",
          raisedBy: "earlier-reviewer", confirmedBy: [], evidence: "The original shared case.", answer: { fixed: true, at: 1, text: "Repaired both owners." } }];
      const oldId = ReviewResult.parse({ verdict: "fail", confirms: ["closed"] });
      expect(oldId.confirms).toEqual(["closed"]); expect(checkReviewEvidence(task.findings, oldId, task)).toContain("closed");
      const result = ReviewResult.parse({ verdict: "fail", confirms: [{ id: "closed", evidence: proof }] });
      expect(result.confirms).toEqual(["closed"]); expect(result.confirmationEvidence).toEqual({ closed: proof });
      expect(checkReviewEvidence(task.findings, result, task)).toBeUndefined();
      await engine["reviews"]["applyReview"](executionFor(task), stage, result, "sol-high", "code-reviewer", "0");
      expect(task.findings).toHaveLength(1); expect(task.findings[0]).toMatchObject({ id: "closed", status: "open", productIds: [second, first], evidence: proof });
      expect(engine.tracking.log.moments({ taskId: task.id, kinds: ["verdict"] }).at(-1)).toMatchObject({ count: 1, blocking: 1, profileId: "sol-high" });
      const saved = structuredClone(task.findings); engine.commitNow(task);
      await owner.stop(engine); engine = f.start(); await engine.waitUntilReady();
      expect(engine.task(task.id)!.findings).toEqual(saved);
      expect(engine.tracking.log.moments({ taskId: task.id, kinds: ["verdict"] }).at(-1)).toMatchObject({ count: 1, blocking: 1, profileId: "sol-high" });
    } finally { await owner.stop(engine); }

  });
});

it("parses a separately owned report without borrowing a closed peer finding's identity or proof", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, task, stage, first, second } = await fixture(owner);
    try {
      await owner.run(engine, async () => {
        task.findings = [{ id: "closed-api", text: "The greeting is missing.", productIds: [second], severity: "blocking", raisedBy: "earlier-reviewer",
            status: "dismissed", confirmedBy: [], evidence: "The old API case." }];
        const result = ReviewResult.parse({ verdict: "fail", findings: [{ text: "The GREETING is missing!", productIds: [first], severity: "important", evidence: proof }] });
        expect(checkReviewEvidence(task.findings, result, task)).toBeUndefined();
        await engine["reviews"]["applyReview"](executionFor(task), stage, result, "opus-high", "code-reviewer", "0");
        expect(task.findings).toHaveLength(2);
        expect(task.findings[0]).toMatchObject({ id: "closed-api", status: "dismissed", productIds: [second], evidence: "The old API case." });
        expect(task.findings[1]).toMatchObject({ status: "open", productIds: [first], evidence: proof });
        expect(task.findings[1]!.id).not.toBe("closed-api");
        expect(engine.tracking.log.moments({ taskId: task.id, kinds: ["verdict"] }).at(-1)).toMatchObject({ count: 1, blocking: 1 });

      });
    } finally { await owner.stop(engine); }

  });
});

for (const severity of ["blocking", "suggestion", "pre-existing"] as const) for (const by of ["sol-high", "opus-high"]) it(`offers verification only when a ${by}-reopened ${severity} is Important`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const { engine, task, stage, first, second } = await fixture(owner);
    try {
      await owner.run(engine, async () => {
        task.rounds[stage.id] = 2; task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 };
        task.findings = [{ id: "dismissed", text: "The greeting is missing.", productIds: [first, second], severity, raisedBy: "opus-high", status: "dismissed", confirmedBy: [] }];
        await engine["reviews"]["applyReview"](executionFor(task), stage, ReviewResult.parse({ verdict: "fail", confirms: [{ id: "dismissed", evidence: proof }] }), by, "code-reviewer", "0");
        task.hunt.reported = { "0": true, "1": true };
        const ballot = engine["reviews"]["pendingVote"](task, stage);
        expect(ballot?.findings.map(finding => finding.id)).toEqual(severity === "blocking" ? ["dismissed"] : undefined);
        if (severity === "blocking") expect(ballot!.voters.length).toBeGreaterThan(0);

      });
    } finally { await owner.stop(engine); }

  });
});
