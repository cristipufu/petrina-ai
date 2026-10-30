import { expect, it } from "vitest";
import { checkOutcome, journeyProblems, journeyView } from "@petrina/core";
import { taskView } from "../../../src/repository-context.js";
import { checkPolicyWorkflow } from "../../fixtures/check-policy-workflow.js";

type Policy = Awaited<ReturnType<typeof checkPolicyWorkflow>>;
async function use(options: Parameters<typeof checkPolicyWorkflow>[0], body: (f: Policy) => Promise<void>) {
  const f = await checkPolicyWorkflow(options);
  try { await body(f); } finally { await f.close(); }
}
const runs = (f: Policy) => f.executions.map(run => run.passed ? "passed" : "failed");
const review = (f: Policy) => f.task.plan!.stages.find(stage => stage.kind === "review-chain")!;
const reviewIndex = (f: Policy) => f.task.plan!.stages.findIndex(stage => stage.kind === "review-chain");
const lines = (f: Policy) => f.task.timeline.map(line => line.text);
const sentBack = (f: Policy) => lines(f).filter(line => line.startsWith("Sent back to the builder: the checks failed")).length;
const latest = (f: Policy) => f.decisions().at(-1)!;
const signal = () => new AbortController().signal;
const validJourney = (f: Policy) => expect(journeyProblems(taskView(f.task))).toEqual([]);

it("does not consume more rounds when reviews were already exhausted, including a saved run from before the update", async () => {
  await use({ sequence: "P", important: true, maxRounds: 1 }, async f => {
    await f.drive();
    const stage = review(f);
    expect(f.task.blockingAfter?.[stage.id]).toEqual([1]);
    expect(lines(f).filter(line => line.startsWith("Review rounds used up"))).toHaveLength(1);
    f.unchanged();
    f.setChecks("F");
    f.requestChanges("Fix what failed");
    await f.drive();
    expect(runs(f)).toEqual(["passed", "failed"]);
    const captured = structuredClone(f.scope.work.checks!);
    // Declared legacy persisted input: the original boundary control retains actual SQLite restart.
    delete f.scope.work.checks!.definition;
    f.task.stageIndex = reviewIndex(f);
    f.state.inbox = [];
    await f.drive();
    expect(runs(f)).toEqual(["passed", "failed"]);
    expect(f.scope.work.checks!.at).toBe(captured.at);
    expect(f.scope.work.checks!.definition).toBeUndefined();
    expect(f.scope.work.checks!.results).toEqual(captured.results);
    expect(f.task.blockingAfter?.[stage.id]).toEqual([1]);
    expect(f.task.rounds[stage.id] ?? 1).toBe(1);
    expect(lines(f).filter(line => line.startsWith("Review rounds used up"))).toHaveLength(1);
    expect(f.starts("code-reviewer")).toHaveLength(1);
    f.unchanged(false);
    f.setChecks("P", false);
    f.requestChanges("Fix the welcome page");
    await f.drive();
    expect(runs(f)).toEqual(["passed", "failed", "passed"]);
    expect(f.task.blockingAfter?.[stage.id]).toEqual([1, 0]);
  });
});

it("runs changed commands on the same code, including at final delivery preparation", async () => {
  await use({ sequence: "F" }, async f => {
    f.unchanged();
    await f.drive();
    const failedTree = f.scope.work.checks!.tree;
    const failedCommand = f.executions[0]!.command;
    f.setChecks("P");
    f.requestChanges("Use the corrected check");
    await f.drive();
    expect(f.scope.work.checks!.tree).toBe(failedTree);
    expect(runs(f)).toEqual(["failed", "passed"]);
    expect(f.executions[1]!.command).not.toBe(failedCommand);
    f.setChecks("P");
    f.approve();
    expect(await f.delivery.beforeShipping(f.scope, signal())).toBe("passed");
    expect(runs(f)).toEqual(["failed", "passed", "passed"]);
    expect(f.executions[2]!.command).not.toBe(f.executions[1]!.command);
  });
});

it("keeps a forced check decision and allows explicit reruns without approving delivery or replenishing repairs", async () => {
  await use({ sequence: "F" }, async f => {
    f.unchanged();
    await f.drive();
    expect(runs(f)).toEqual(["failed"]);
    expect(f.task.stageIndex).toBe(reviewIndex(f));
    const id = latest(f).id;
    expect(() => f.approve()).toThrow("delivery has not been approved");
    expect(latest(f).id).toBe(id);
    expect(runs(f)).toEqual(["failed"]);
    f.rerun();
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed"]);
    expect(f.scope.work.checks!.results[0]!.output).toContain("captured failure");
    expect(f.scope.work.checkReturns).toBe(2);
    expect(f.scope.work.approvedSha).toBeUndefined();
    expect(f.task.error).toBeUndefined();
    f.setChecks("P", false);
    f.rerun();
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed", "passed"]);
    expect(f.starts("code-reviewer")).toHaveLength(1);
    expect(f.scope.work.checkReturns).toBeUndefined();
  });
});

it("reviews a real fix normally after port checks fail with builder returns available", async () => {
  await use({ sequence: "P", pair: true }, async f => {
    await f.drive();
    expect(f.starts("code-reviewer")).toHaveLength(2);
    expect(f.scope.work.reviewedTree).toBeDefined();
    // Adapter input from a completed port; the native exhausted-return anchor proves conflict files.
    f.scope.work.portReview = { from: "declared:old-base", head: "declared:feature", onto: "declared:new-base", files: ["greeting.txt"] };
    f.setChecks("FP");
    f.task.stageIndex = reviewIndex(f);
    f.state.inbox = [];
    await f.drive();
    expect(runs(f)).toEqual(["passed", "failed", "passed"]);
    expect(f.scope.work.portReview).toBeUndefined();
    expect(f.starts("code-reviewer")).toHaveLength(4);
    expect(f.task.rounds[review(f).id] ?? 1).toBe(1);
  });
});

it("gives a later failure its own two repairs after a genuine pass, and reviews and retests a fix made after review passed", async () => {
  await use({ sequence: "FFP", tester: true }, async f => {
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed", "passed"]);
    expect(sentBack(f)).toBe(2);
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.starts("builder")).toHaveLength(2);
    expect(f.starts("tester")).toHaveLength(1);
    expect(f.starts("code-reviewer")).toHaveLength(2);
    expect(latest(f).title).toBe("Ready to ship “Add a greeting”");
    f.setChecks("FFP");
    f.approve();
    expect(await f.delivery.beforeShipping(f.scope, signal())).toBe("returned");
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed", "passed", "failed", "failed", "passed"]);
    expect(sentBack(f)).toBe(4);
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.starts("builder")).toHaveLength(4);
    expect(f.starts("code-reviewer")).toHaveLength(4);
    expect(f.starts("tester")).toHaveLength(2);
    expect(f.task.state).toBe("needs-you");
    expect(f.scope.work.approvedSha).toBeUndefined();
    expect(latest(f).title).toBe("Ready to ship “Add a greeting”");
    validJourney(f);
    f.approve();
    expect(await f.delivery.beforeShipping(f.scope, signal())).toBe("passed");
    expect(f.executions).toHaveLength(6);
  });
});

it("keeps a pending review round when check repairs run out, and runs it with its number after a passing fix", async () => {
  await use({ sequence: "PFFFP", tester: true, important: true }, async f => {
    await f.drive();
    const stage = review(f);
    expect(runs(f)).toEqual(["passed", "failed", "failed", "failed"]);
    expect(f.task.stageIndex).toBe(reviewIndex(f));
    expect(f.task.rounds[stage.id]).toBe(2);
    expect(f.task.blockingAfter?.[stage.id]).toEqual([1]);
    expect(f.scope.work.checkReturns).toBe(2);
    expect(sentBack(f)).toBe(2);
    expect(f.starts("code-reviewer")).toHaveLength(2);
    expect(f.starts("tester")).toHaveLength(1);
    expect(f.scope.work.reviewedSha).toBeDefined();
    const item = latest(f);
    expect(item.title).toBe("Your call on “Add a greeting”: a check still fails (Welcome)");
    expect(f.task.statusLine).toBe("Checks still fail. Your call");
    expect(item.body).toContain("Still failing after 2 automatic Builder turns.\n• Welcome failed: The welcome page is missing (captured failure)");
    expect(item.body).toContain("The Builder's last answer, saying it fixed this: “Fixed it.”");
    expect(item.body).toContain("Stopped before the review (round 2). A reviewer has not yet confirmed 2 fixes the Builder made for review findings.");
    expect(item.body).toMatch(/After the Builder's next turn, still to come: code review again \([^)]*\), then final acceptance testing \([^)]*\) if the code changed, then your OK to ship/);
    expect(item.body).toContain("Send back with a note to give the Builder one more turn. Approving does not ship while checks fail or remain unverified.");
    // Kernel summary wording stays in the native later-failed-acceptance anchor.
    expect(f.scope.work.checks!.results.filter(run => checkOutcome(run).kind === "failed")).toHaveLength(1);
    expect(lines(f)).toContain("Checks still fail after 2 automatic Builder turns (Welcome), so Petrina waits for you before the review (round 2)");
    const upcoming = journeyView(taskView(f.task), { roles: f.state.roles, profiles: f.state.profiles, tasks: f.state.tasks.map(taskView), inbox: f.state.inbox }).nodes.filter(node => node.state === "next" || node.state === "ahead").map(node => node.name);
    expect(upcoming.indexOf("Code reviewers (round 2)")).toBeGreaterThanOrEqual(0);
    expect(upcoming.indexOf("Code reviewers (round 2)")).toBeLessThan(upcoming.indexOf("Your delivery check"));
    validJourney(f);
    f.requestChanges("Fix the welcome check");
    await f.drive();
    expect(runs(f)).toEqual(["passed", "failed", "failed", "failed", "passed"]);
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.starts("code-reviewer")).toHaveLength(4);
    expect(f.task.rounds[stage.id]).toBe(2);
    expect(f.task.blockingAfter?.[stage.id]).toEqual([1, 0]);
    expect(f.starts("tester")).toHaveLength(2);
    expect(latest(f).title).toBe("Ready to ship “Add a greeting”");
    validJourney(f);
  });
});

it("runs unchanged work only on the coordinator's explicit request and resumes review after a pass", async () => {
  await use({ sequence: "FFP" }, async f => {
    f.unchanged();
    await f.drive();
    expect(f.scope.work.checkReturns).toBe(2);
    expect(runs(f)).toEqual(["failed"]);
    const firstStep = structuredClone(f.checkSteps()[0]);
    f.rerun();
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed"]);
    expect(f.scope.work.checkReturns).toBe(2);
    expect(f.scope.work.approvedFor).toBeUndefined();
    expect(f.starts("builder")).toHaveLength(2);
    expect(f.checkSteps()).toHaveLength(2);
    f.rerun();
    await f.drive();
    expect(runs(f)).toEqual(["failed", "failed", "passed"]);
    expect(f.starts("code-reviewer")).toHaveLength(1);
    expect(f.scope.work.approvedFor).toBeUndefined();
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.checkSteps()).toHaveLength(3);
    expect(f.checkSteps()[0]).toEqual(firstStep);
  });
});

for (const shared of [false, true]) it(`updates each product once before the Tester (${shared ? "shared" : "single"} task)`, async () => {
  await use({ sequence: "P", tester: true, shared }, async f => {
    await f.drive();
    expect(f.task.error).toBeUndefined();
    expect(f.starts("tester").length).toBeGreaterThan(0);
    expect(f.testerPreparations[0]).toEqual(f.evidence.map(evidence => evidence.scope.work.productId));
  });
});
