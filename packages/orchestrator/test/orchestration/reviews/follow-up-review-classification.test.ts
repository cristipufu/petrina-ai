import { expect, it } from "vitest";
import { followUpLinksFixture, older, STEPS, EVIDENCE, STAGE } from "../../fixtures/follow-up-links.js";
import { report } from "../../fixtures/review-reports.js";
import type { RuntimeTask } from "../../../src/model.js";

it("keeps independent classifications separate and requires explicit identity for agreement", async () => {
  const f = followUpLinksFixture();

  try {
    const review = async (task: RuntimeTask, severity: "pre-existing" | "important", by: string, key: string) => {
      await f.reports.apply(task, STAGE, report({ verdict: "fail", findings: [{ text: "bug-clash: The footer opens a retired page.", severity, evidence: EVIDENCE, steps: STEPS }] }), by, "code-reviewer", key);
    };
    for (const first of ["pre-existing", "important"] as const) {
      const task = f.taskOf(f.shop, `${first} first`, []);
      await review(task, first, "opus-high", "0");
      await review(task, first === "important" ? "pre-existing" : "important", "sol-high", "1");
      expect(task.findings).toHaveLength(2);
      expect(new Set(task.findings.map((finding) => finding.id)).size).toBe(2);
      expect(task.findings.map((finding) => finding.severity).sort()).toEqual(["blocking", "pre-existing"]);
      expect(task.findings.every((finding) => finding.confirmedBy.length === 0)).toBe(true);
      expect(f.ballots.next(task, STAGE)?.findings).toHaveLength(1);
    }
    const once = f.taskOf(f.shop, "Two blind important reports", []);
    await review(once, "important", "opus-high", "0"); await review(once, "important", "sol-high", "1");
    expect(once.findings).toHaveLength(2);
    expect(f.ballots.next(once, STAGE)?.findings).toHaveLength(2);
    await f.reports.apply(once, STAGE, report({ verdict: "fail", confirms: [once.findings[0]!.id], confirmationEvidence: { [once.findings[0]!.id]: EVIDENCE } }), "sol-high", "code-reviewer", "1");
    expect(once.findings[0]!.confirmedBy).toEqual(["sol-high"]);
    expect(f.ballots.next(once, STAGE)?.findings.map((finding) => finding.id)).toEqual([once.findings[1]!.id]);

    const settled = older("settled", "bug-clash: The footer opens a retired page.", {
      verification: { by: "sol-high", verdict: "pre-existing", reason: "The previous version already opened the retired page.", at: 5 },
      votes: [{ by: "grok-high", toolId: "grok", verdict: "pre-existing", reason: "The footer was already wrong before this change." }],
    });
    const task = f.taskOf(f.shop, "Checked as older", [settled]);
    await f.finish(task);
    expect(f.cardFor("clash")).toHaveLength(1);
    expect(f.cardFor("clash")[0]!.description.match(/The footer was already wrong before this change\./g)).toHaveLength(1);
    expect(f.cardFor("clash")[0]!.description).toContain(settled.verification!.reason);
    expect(f.cardFor("clash")[0]!.description).toContain(settled.votes![0]!.reason);
    const thin = f.taskOf(f.shop, "No steps", [older("thin", "bug-thin: The footer opens a retired page.", { steps: undefined, evidence: undefined, verification: settled.verification, votes: settled.votes })]);
    await f.finish(thin);
    expect(thin.findings[0]!.tracking).toEqual({ reason: "missing-steps" });
    expect(f.cardFor("thin")).toHaveLength(0);
  } finally { await f.stop(); }
});
