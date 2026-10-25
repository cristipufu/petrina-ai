import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";
import { ReviewResult } from "../../../src/roles.js";
import { checkReviewEvidence } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { createFollowUpFixtures, STEPS, EVIDENCE, STAGE, older, groupByBug, taskOf, finish, cardFor } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("settles an incidental older-bug repair only from current explicit proof, retaining unknown and contested reports", async () => {
  const world = await open(groupByBug, false, true);
  try {
    const engine = world.engine;
    const task = taskOf(engine, world.shop, "Incidental repair", [older("fixed", "bug-fixed: A repaired bug"), older("unknown", "bug-unknown: Not checked"), older("contested", "bug-contested: Still broken")]);
    task.plan = { rationale: "Review current evidence", plannerProfileId: "sol-high", stages: [STAGE] }; task.stageIndex = 0;
    const work = executionFor(task).work;
    work.worktree = engine.productOf(task)!.path!;
    work.baseSha = await gitOps.head(work.worktree);
    work.base = "main";
    task.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 3 };
    await engine["reviews"]["input"](task, new AbortController().signal);
    const evidence = "Repeated the exact original reproduction on the current commit; About now opens the current page, and the neighbouring Home control still passes.";
    const resolved = ReviewResult.parse({ verdict: "pass", findings: [{ text: "bug-remaining: A distinct remaining variant", severity: "pre-existing", steps: STEPS, evidence: EVIDENCE }], resolves: [{ id: "fixed", evidence }, { id: "contested", evidence }] });
    expect(checkReviewEvidence(task.findings, resolved)).toBeUndefined();
    expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "pass", resolves: [{ id: "not-shown", evidence }] }))).toContain("not shown");
    expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "pass", resolves: [{ id: "fixed", evidence }], confirms: ["fixed"] }))).toContain("without also");
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, resolved, "opus-high", "code-reviewer", "0");
    task.hunt.reported["0"] = true;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings[0]!.status).toBe("open"); // The blind peer has not finished.
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, ReviewResult.parse({ verdict: "pass", confirms: [{ id: "contested", evidence: "Current reproduction still fails for the other account." }] }), "sol-high", "code-reviewer", "1");
    task.hunt.reported["1"] = true;
    const input = task.hunt.input;
    delete task.hunt.input;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings[0]!.status).toBe("open"); // No code binding is not proof.
    task.hunt.input = input;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings.map(finding => finding.status)).toEqual(["fixed", "open", "open", "open"]);
    expect(task.findings[0]!.resolution).toMatchObject({ by: "opus-high", evidence, versions: { [world.shop]: work.baseSha } });
    await finish(engine, task);
    expect(task.findings[0]!.tracking).toBeUndefined();
    expect(task.findings[1]!.tracking).toHaveProperty("taskId");
    expect(task.findings[2]!.tracking).toHaveProperty("taskId");
    expect(cardFor(engine, "remaining")[0]!.title).toBe("bug-remaining: A distinct remaining variant");
    // A later current reproduction reopens the original identity and retains its repair proof as history.
    task.hunt = { stageId: STAGE.id, round: 2, reported: {}, findings: 3 };
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, ReviewResult.parse({ verdict: "fail", confirms: [{ id: "fixed", evidence: "The exact reproduction fails again on a later commit." }] }), "sol-high", "code-reviewer", "1");
    expect(task.findings[0]!.status).toBe("open");
    expect(task.findings[0]!.resolution).toBeUndefined();
    expect(task.findings[0]!.earlierReviews?.at(-1)?.resolution?.evidence).toBe(evidence);
  } finally { await shutdown(world.engine); }
});
