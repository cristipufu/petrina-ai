import { expect, it } from "vitest";
import { acceptancePolicyWorkflow, REPAIR_CHECK, STILL_FAILS } from "../../fixtures/acceptance-policy-workflow.js";

const ALL_SEATS = ["review:1:code-reviewer:opus-high", "review:1:code-reviewer:sol-high", "security:1:security-reviewer:opus-high"];
type Fixture = Awaited<ReturnType<typeof acceptancePolicyWorkflow>>;
async function use(options: Parameters<typeof acceptancePolicyWorkflow>[0], body: (f: Fixture) => Promise<void>) {
  const f = await acceptancePolicyWorkflow(options);
  try { await body(f); } finally { await f.close(); }
}
const reviewSteps = (f: Fixture) => f.task.journey!.filter(step => step.kind === "agent" && ["review", "security"].includes(step.stageId ?? ""));

it("runs every owed review after a successful early acceptance repair, then ships on its own as the task's settings allow", async () => {
  await use({ gate: false }, async f => {
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["fixed"]);
    const results = reviewSteps(f);
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => [...step.result?.findingChanges?.claimedFixed ?? [], ...step.result?.findingChanges?.fixed ?? []])).toEqual([]);
    expect(f.task.timeline.some(entry => entry.text === "Trying the acceptance list once more on the final code")).toBe(false);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(0);
    expect(f.decisions()).toEqual([]);
    // This is an actual driver request for its publication effect; native anchors prove moved main refs.
    expect(f.publicationRequests).toEqual([f.task.id]);
    expect(f.runs("tester")).toHaveLength(2);
  });
});

it("keeps used-up acceptance failures open for one decision after every owed review, at the planned delivery check", async () => {
  await use({ exhausted: true }, async f => {
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
    expect(f.task.acceptanceBlocked).toBe(true);
    expect(f.task.timeline.filter(entry => entry.text === STILL_FAILS)).toHaveLength(1);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.rounds.review ?? 1).toBe(1);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["open"]);
    const held = f.heldFailure()[0]!, results = reviewSteps(f);
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => step.result?.findings ?? []).some(finding => finding.id === held.id)).toBe(false);
    expect(results.flatMap(step => step.result?.findingChanges?.claimedFixed ?? [])).toEqual([]);
    expect(held.reopenedAt).toBeUndefined();
    const reports = f.reviewReports();
    expect(reports.map(report => [report.openImportant, report.stillOpen, report.reopened, report.heldForDecision,
      (report.reportCounts as { closing: { open: { important: number } } }).closing.open.important]))
      .toEqual([[[held.id], [held.id], [], [held.id], 1], [[held.id], [held.id], [], [held.id], 1]]);
    expect(reports[0]!.summary).toContain("3 open reports (1 Important, 2 nits, 0 pre-existing follow-ups); 1 of the Important is an acceptance failure held for your delivery decision, not review work;");
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.proofDeliveryGate).toBeUndefined();
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check"))).toEqual([]);
    expect(f.decisions()).toHaveLength(1);
    expect(f.decisions()[0]!.title).toBe("Your call on “Show the greeting”: 1 blocking finding still open");
    expect(f.task.statusLine).toBe("Acceptance still fails after the builder's returns. Your call");
    expect(f.publicationRequests).toEqual([]);
    // Actual durable restart, approval, both main refs and publication remain in the retained native pair.
    expect(f.runs("tester")).toHaveLength(3);
  });
});

it("keeps an early acceptance repair on its route through the owed reviews across a resumed retry input", async () => {
  await use({}, async f => {
    const first = f.evidence[0]!.scope.work.productId;
    await f.drive(task => task.repair?.kind === "acceptance");
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    const restoredRepair = structuredClone(f.task.repair!);
    // Declared resumed controller input; the retained native anchor performs Store restart and Engine.fail/retry.
    f.task.repair = restoredRepair;
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    await f.drive(task => task.repairCheck === true);
    expect(f.order()).toEqual(["test", "build:1"]);
    expect(f.view()).toEqual(["Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)",
      ["Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
    // The real native prompt anchor checks both repair-specific sentences and absence of final-acceptance wording.
  });
});

it("shows the repair's acceptance test next while product checks run before it and while a failed check is repaired first", async () => {
  await use({ holdCheck: true }, async f => {
    const driving = f.drive(task => task.repair?.kind === "checks");
    try {
      await f.held;
      expect(f.task.repairCheck).toBe(true);
      expect(f.view()).toEqual(["Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)",
        ["Automated checks (again): now", "Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    } finally { f.releaseCheck(); await driving; }
    expect(f.task.repair?.kind).toBe("checks");
    expect(f.task.repairCheck).toBe(true);
    expect(f.view()).toEqual(["Next: fixes by the builder (Codex · sol), then acceptance testing of the repair (Claude Code · Opus 5.5)",
      ["Builder (fixes 2): next", "Tester (again): ahead", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
  });
});
