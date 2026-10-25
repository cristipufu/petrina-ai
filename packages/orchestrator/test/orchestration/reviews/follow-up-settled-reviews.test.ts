import { expect, it } from "vitest";
import { followUpLinksFixture, older, STEPS, EVIDENCE, STAGE } from "../../fixtures/follow-up-links.js";
import { report } from "../../fixtures/review-reports.js";
import type { RuntimeTask } from "../../../src/model.js";

it("waits until every reviewer has answered before tracking an older bug, and drops the credit if it becomes Important", async () => {
  const f = followUpLinksFixture();

  try {
    const review = async (task: RuntimeTask, text: string, severity: "pre-existing" | "important", by: string, key: string) => {
      const result = report({ verdict: "fail", findings: [{ text, severity, evidence: EVIDENCE, steps: STEPS }] });
      await f.reports.apply(task, STAGE, result, by, "code-reviewer", key);
    };
    const plan = { stages: [STAGE], rationale: "Review it", plannerProfileId: "opus-high" };
    const still = f.taskOf(f.shop, "Still reviewing", []);
    still.plan = plan;
    still.state = "running";
    still.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 0 };
    await review(still, "bug-split: The footer opens a retired page.", "pre-existing", "opus-high", "0");
    still.hunt = { ...still.hunt, reported: { "0": true } };
    const done = f.taskOf(f.shop, "Already done", [older("done", "bug-split: About in the footer is the old page.")]);
    await f.finish(done);
    const card = f.cardFor("split")[0]!;
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    await review(still, "bug-split: The footer opens a retired page.", "important", "sol-high", "1");
    expect(still.findings).toHaveLength(2);
    expect(still.findings[1]!.severity).toBe("blocking");
    // A completed verifier can reclassify the older report itself; similar prose cannot.
    still.findings[0]!.severity = "blocking";
    still.findings[0]!.verification = { by: "sol-high", verdict: "real", reason: "This exact report reproduces only on the changed version.", at: f.now() };
    await f.links.catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    const sample = card.followUp!.reports[0]!;
    card.followUp!.reports.push({ ...sample, taskId: still.id, findingId: still.findings[0]!.id, text: still.findings[0]!.text });
    still.findings[0]!.tracking = { taskId: card.id };
    await f.links.catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    const early = f.taskOf(f.shop, "Judged first", []);
    early.plan = plan;
    early.state = "running";
    early.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 0 };
    await review(early, "bug-early: The footer opens a retired page.", "pre-existing", "opus-high", "0");
    await review(early, "bug-early: The footer opens a retired page.", "important", "sol-high", "1");
    const other = f.taskOf(f.shop, "Other done", [older("other", "bug-early: The footer opens a retired page.")]);
    await f.finish(other);
    expect(f.cardFor("early")[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["other"]);
    expect(early.findings[0]!.tracking).toBeUndefined();

    const agreed = f.taskOf(f.shop, "Both agreed", [older("agreed", "bug-agreed: The footer opens a retired page.", { judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }] })]);
    agreed.plan = plan;
    agreed.state = "running";
    agreed.hunt = { stageId: STAGE.id, round: 1, reported: { "0": true, "1": true }, findings: 0 };
    const later = f.taskOf(f.shop, "Later done", [older("later", "bug-agreed: About in the footer is the old page.")]);
    await f.finish(later);
    expect(f.cardFor("agreed")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["agreed", "later"]);
    expect(agreed.findings[0]!.tracking).toEqual({ taskId: f.cardFor("agreed")[0]!.id });

    // Raised before this round, and only one of the two reviewers has answered.
    const olderRound = f.taskOf(f.shop, "Reviewed again", [older("again", "bug-round: The footer opens a retired page.")]);
    olderRound.plan = plan;
    olderRound.state = "running";
    olderRound.hunt = { stageId: STAGE.id, round: 2, reported: { "0": true }, findings: 1 };
    const roundDone = f.taskOf(f.shop, "Round done", [older("done-round", "bug-round: About in the footer is the old page.")]);
    await f.finish(roundDone);
    expect(f.cardFor("round")[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["done-round"]);
    expect(olderRound.findings[0]!.tracking).toBeUndefined();

    const both = f.taskOf(f.shop, "Round agreed", [older("round-agreed", "bug-roundready: The footer opens a retired page.")]);
    both.plan = plan;
    both.state = "running";
    both.hunt = { stageId: STAGE.id, round: 2, reported: { "0": true, "1": true }, findings: 1 };
    const roundLater = f.taskOf(f.shop, "Round later", [older("round-later", "bug-roundready: About in the footer is the old page.")]);
    await f.finish(roundLater);
    expect(f.cardFor("roundready")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["round-agreed", "round-later"]);
    expect(both.findings[0]!.tracking).toEqual({ taskId: f.cardFor("roundready")[0]!.id });
  } finally { await f.stop(); }
});
