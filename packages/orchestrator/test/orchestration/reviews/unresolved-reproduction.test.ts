import { describe, expect, it } from "vitest";
import { findingsNeedingVotes } from "@petrina/core";
import { reviewSelectionFixture } from "../../fixtures/review-selection.js";
import { report } from "../../fixtures/review-reports.js";
  type Hunted = { stageId: string; round: number; input?: { heads: Readonly<Record<string, string>> } };
  const ballotOn = (hunt: Hunted, seat: string) => ({ stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } });
  const answer = (hunt: Hunted, seat: string, by: string, toolId: string, verdict: "real" | "nit" | "not-a-bug") => ({ by, toolId, plannedProfileId: seat, verdict, reason: `${toolId} answered ${verdict} for its place.`, ballot: ballotOn(hunt, seat) });

describe("bounded verifier places after handoffs", () => {
it("reopens a finding a vote left unresolved when a reviewer brings a current reproduction", async () => {
    const f = reviewSelectionFixture(["sol-high", "opus-high"], ["u", "kept"], 2);
    const round1 = { stageId: f.stage.id, round: 1, input: { heads: { p: f.base } } };
    for (const finding of f.task.findings) {
      finding.votes = [answer(round1, "sol-high", "sol-high", "codex", "nit"), answer(round1, "grok-high", "grok-high", "grok", "nit")];
      finding.unresolved = { at: 1, reason: "No ready independent tool could give the third answer.", heads: { p: f.base } };
    }
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: 2, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
      const evidence = "On the changed code the u greeting is still missing: expected Hello Ada, observed Hello. The kept page shows its greeting.";
      f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["u", "kept"], confirmationEvidence: { u: evidence } }), "argon-high", "code-reviewer", "0");
      const u = f.task.findings[0]!, kept = f.task.findings[1]!;
      expect(u.unresolved).toBeUndefined();
      expect(u.votes).toBeUndefined();
      expect(u.reopenedAt).toBeDefined();
      expect(u.evidence).toBe(evidence);
      expect(u.confirmedBy).toEqual(["argon-high"]);
      expect(u.earlierReviews?.[0]?.unresolved?.reason).toBe("No ready independent tool could give the third answer.");
      expect(u.earlierReviews?.[0]?.votes).toHaveLength(2);
      // A confirmation without a reproduction keeps the unresolved episode, and its completed ballot is not repeated.
      expect(kept.unresolved).toBeDefined();
      expect(kept.votes).toHaveLength(2);
      expect(findingsNeedingVotes(f.task, id => f.profile(id)?.toolId).map((finding) => finding.id)).toEqual(["u"]);
  });
});

describe("bounded verifier places after handoffs", () => {
for (const recorded of ["commit", "commit and tree"] as const) it(`keeps a finding a vote left unresolved when a written confirmation arrives on the same code, its ${recorded} saved`, async () => {
    const f = reviewSelectionFixture(["sol-high", "opus-high"], ["u"], 2);
    const tree = f.tree;
    const round1 = { stageId: f.stage.id, round: 1, input: { heads: { p: f.first } } };
    const finding = f.task.findings[0]!;
    finding.votes = [answer(round1, "sol-high", "sol-high", "codex", "nit"), answer(round1, "grok-high", "grok-high", "grok", "nit")];
    finding.unresolved = { at: 1, reason: "No ready independent tool could give the third answer.", heads: { p: f.first }, ...(recorded === "commit" ? {} : { trees: { p: tree } }) };
    const saved = structuredClone(finding.unresolved);
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: 1, input: { file: "input.json", digest: "d", heads: { p: f.first }, trees: { p: tree } } };
      const restated = "The u greeting is still missing: expected Hello Ada, observed Hello.";
      f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["u"], confirmationEvidence: { u: restated } }), "argon-high", "code-reviewer", "0");
      f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["u"], confirmationEvidence: { u: restated } }), "opus-high", "code-reviewer", "1");
      expect(finding.unresolved).toEqual(saved);
      expect(finding.votes).toHaveLength(2);
      expect(finding.reopenedAt).toBeUndefined();
      expect(finding.earlierReviews).toBeUndefined();
      expect(finding.confirmedBy).toEqual(["argon-high", "opus-high"]);
      expect(findingsNeedingVotes(f.task, id => f.profile(id)?.toolId)).toEqual([]);
  });
});
