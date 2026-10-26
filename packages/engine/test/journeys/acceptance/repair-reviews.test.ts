import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyView, nextLine } from "@petrina/core";
import { waitFor } from "@petrina/test-support/fixtures";
import { commandInputText } from "../../../src/checks.js";
import { acceptanceRepairFixtures, GREETING, PHONE, UNAVAILABLE, failing, passed, blocked, REPAIR_CHECK, FINAL_TEST, STILL_FAILS, ALL_SEATS } from "../../fixtures/acceptance-repairs.js";

const { fixture, close: closeFixtures } = acceptanceRepairFixtures();
afterAll(closeFixtures);

for (const [gate, custom] of [[false, false]] as const) it(`runs every owed review after a successful early acceptance repair, then ${gate ? "asks at the planned delivery check" : "ships on its own as the task's settings allow"}${custom ? " (custom acceptance role)" : ""}`, async () => {
  const f = await fixture({ gate, custom });
  try {
    const [first] = f.ids;
    // The first product fails acceptance; the Builder's repair (it adds the welcome page) passes.
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    const before = await f.mains();
    await f.drive();
    // Only the affected product went back to the Builder, once; ordinary acceptance testing then checked the repair,
    // and both code review seats and the security review ran after it, in plan order.
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", ...(gate ? ["decision"] : [])]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.runs(f.tester)[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["fixed"]);
    // Acceptance testing settled the repaired failure; the reviews record neither the Builder's claim nor that fix as theirs.
    const results = f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === f.review.id || step.stageId === f.security.id));
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => [...step.result?.findingChanges?.claimedFixed ?? [], ...step.result?.findingChanges?.fixed ?? []])).toEqual([]);
    // No final retest of unchanged work, and no checkpoint the plan did not have.
    expect(f.task.timeline.some(entry => entry.text === "Trying the acceptance list once more on the final code")).toBe(false);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(gate ? 1 : 0);
    if (gate) {
      expect(f.decisions()).toHaveLength(1);
      expect(await f.mains()).toEqual(before);
      f.engine.approve(f.decisions()[0]!.id);
      await f.drive();
    } else expect(f.decisions()).toEqual([]);
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect((await f.mains()).every((sha, index) => sha !== before[index])).toBe(true);
    expect(f.runs(f.tester)).toHaveLength(2);
  } finally { await f.close(); }
});



// The actual controller owns role/gate and mixed-evidence permutations; retain native exhausted evidence and restart/repair pairs.
for (const [gate, mixed] of [[true, false]] as const) it(`keeps used-up acceptance failures open for one decision after every owed review, at ${gate ? "the planned" : "an added"} delivery check${mixed ? ", beside an unavailable item" : ""}`, async () => {
  const f = await fixture({ gate, checklist: mixed ? [GREETING, PHONE] : [GREETING] });
  try {
    const [first, second] = f.ids;
    // The failure is reproduced on every run: both of the first product's returns are used.
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first]), ...(mixed ? [blocked([second])] : [])] });
    const before = await f.mains();
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
    expect(f.task.acceptanceBlocked).toBe(true);
    expect(f.task.timeline.filter(entry => entry.text === STILL_FAILS)).toHaveLength(1);
    // Every planned seat reviewed once: the held failure started no fix round, and no Builder claim closed it.
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.rounds[f.review.id] ?? 1).toBe(1);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["open"]);
    // Each review's saved result holds only what that review looked at: the Builder's earlier claims about the held
    // failure were already tested by acceptance, and the failure is no review finding.
    const [held] = f.heldFailure();
    const results = f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === f.review.id || step.stageId === f.security.id));
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => step.result?.findings ?? []).some(finding => finding.id === held!.id)).toBe(false);
    expect(results.flatMap(step => step.result?.findingChanges?.claimedFixed ?? [])).toEqual([]);
    // Reviewers are not asked about it and never reopen it. Each review's completion report keeps its task-wide counts,
    // where the failure really is still open and Important, and names it as held for your decision rather than review work.
    for (const role of ["code-reviewer", "security-reviewer"]) expect(f.responses.prompts(role).some(text => text.includes(held!.id))).toBe(false);
    expect(held!.reopenedAt).toBeUndefined();
    const reports = await f.reviewReports();
    expect(reports.map(report => [report.openImportant, report.stillOpen, report.reopened, report.heldForDecision, report.reportCounts.closing.open.important]))
      .toEqual([[[held!.id], [held!.id], [], [held!.id], 1], [[held!.id], [held!.id], [], [held!.id], 1]]);
    expect(reports[0]!.summary).toContain("3 open reports (1 Important, 2 nits, 0 pre-existing follow-ups); 1 of the Important is an acceptance failure held for your delivery decision, not review work;");
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.proofDeliveryGate === undefined).toBe(gate);
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check")).map(entry => entry.text)).toEqual(gate ? [] : [mixed
      ? "Added your delivery check: a required acceptance check could not be verified, so delivery waits for your decision"
      : "Added your delivery check: acceptance still fails, so delivery waits for your decision"]);
    expect(f.decisions()).toHaveLength(1);
    const [decision] = f.decisions();
    expect(decision!.title).toBe("Your call on “Show the greeting”: 1 blocking finding still open");
    expect(f.task.statusLine).toBe("Acceptance still fails after the builder's returns. Your call");
    if (mixed) expect(decision!.body).toContain(`• ${PHONE} (Product 2) — ${UNAVAILABLE}`);
    expect(await f.mains()).toEqual(before);
    expect(f.task.repositories!.every(work => !work.landed)).toBe(true);
    // A restart keeps the used returns, the hold and the one pending decision.
    await f.restart();
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
    expect(f.decisions().map(item => item.id)).toEqual([decision!.id]);
    // Your explicit approval ships both products, with no further acceptance run, Builder return or review.
    f.engine.approve(decision!.id);
    await f.drive();
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect((await f.mains()).every((sha, index) => sha !== before[index])).toBe(true);
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
  } finally { await f.close(); }
});

for (const continued of [true]) it(`repairs an independent review finding on its own product only, without handing over a used-up acceptance failure${continued ? " to a Builder continuing its conversation" : ""}`, async () => {
  const f = await fixture({ gate: true });
  try {
    const [first, second] = f.ids;
    // A failure owned by both products uses up both returns; then a reviewer raises an Important finding on the first product.
    f.responses.configure({ builder: "plain", reviewer: "important", affectedProducts: [first], testerChecks: [failing([first, second])], ...(continued ? { reopen: "resume" as const } : {}) });
    await f.drive(task => task.repair?.kind === "review");
    expect(f.task.repair?.kind).toBe("review");
    const review = f.task.findings.find(finding => finding.text === "The greeting is missing on the welcome page.")!;
    const nit = f.task.findings.find(finding => finding.text === "Consider a friendlier greeting.")!;
    expect(nit.severity).toBe("suggestion");
    // Parallel reviewers may finish in either order. Exercise a leading Important report for the fresh Builder
    // and a leading nit for the continuing Builder, without relying on process timing or changing worker counts.
    const leading = continued ? nit : review;
    f.task.findings = [leading, ...f.task.findings.filter(finding => finding.id !== leading.id)];
    await f.drive();
    expect(f.order().slice(0, 7)).toEqual(["test", "build:1", "build:2", "test", "build:1", "build:2", "test"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
    const [held] = f.heldFailure();
    expect(review.productIds).toEqual([first]);
    // The review's repair visited only its finding's product, and asked only about that finding.
    expect(f.order().slice(7)).toEqual(["review", "build:1", "review", "security", "decision"]);
    expect(f.runs("builder").at(-1)!.findingIds).toContain(review.id); expect(f.runs("builder").at(-1)!.findingIds).not.toContain(held!.id);
    // Fresh or continued, the Builder's instructions and the saved context it is told to read leave the held failure out.
    // A continuing Builder, which was given it in an earlier repair, is told it is no longer in its list.
    const prompt = f.responses.prompts("builder").at(-1)!;
    expect(prompt).toContain(review.text); expect(prompt).not.toContain(held!.text);
    expect(prompt).not.toContain(`[${held!.id}]`); expect(prompt).not.toContain(`${held!.id}: open`);
    if (continued) {
      const index = prompt.split("## Current finding status index\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
      expect(index).toContain(`- ${review.id}: open, important`);
      expect(index).toContain(`- ${nit.id}: open, nit`);
      expect(index).toContain(`No longer present: ${held!.id}.`);
    } else expect(prompt).not.toContain(held!.id);
    const packet = readFileSync(f.task.repositories![0]!.builderSession!.context!.file, "utf8");
    expect(packet).toContain(review.id); expect(packet).not.toContain(held!.id); expect(packet).not.toContain(held!.text);
    expect(review.status).toBe("fixed");
    // The held failure counted toward neither round, and the Builder's answer about the other finding did not close it.
    expect(f.task.blockingFindingsAfter![f.review.id]).toEqual([[review.id], []]);
    expect(held!.status).toBe("open");
    expect(f.seats()).toEqual([...ALL_SEATS, "review:2:code-reviewer:opus-high", "review:2:code-reviewer:sol-high"].sort());
    expect(f.decisions()).toHaveLength(1);
    expect(f.task.statusLine).toBe("Acceptance still fails after the builder's returns. Your call");
  } finally { await f.close(); }
});

it("keeps an early acceptance repair on its route through the owed reviews across a restart and a retry", async () => {
  const f = await fixture({ gate: true });
  try {
    const [first] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    // Petrina stops before the Builder starts its repair; the saved repair is an early one, as is one saved before this mark existed.
    await f.drive(task => task.repair?.kind === "acceptance");
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    await f.restart();
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    // The step gets stuck and you retry it.
    f.engine.fail(f.task.id, new Error("The Builder's tool stopped answering"));
    await f.engine.retry(f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "stuck")!.id);
    // The repair is finished; you pause before its acceptance test starts. That test still shows as next, then the reviews.
    await f.drive(task => task.repairCheck === true);
    expect(f.order()).toEqual(["test", "build:1"]);
    f.engine.pause(f.task.id);
    const state = f.engine.getState(), shown = state.tasks.find(task => task.id === f.task.id)!;
    expect(nextLine(state, shown)).toBe("Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)");
    expect(journeyView(shown, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter(node => ["next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`))
      .toEqual(["Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]);
    f.engine.resume(f.task.id);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    // The Tester is told it checks the repair before review, not that this is final testing after review.
    const told = f.responses.openings("tester").at(-1)!;
    expect(told).toContain("This acceptance run checks the builder's repair of an earlier run that did not pass, before review.");
    expect(told).toContain("This run checks the builder's repair of the prior acceptance run, which did not pass; the planned reviews follow.");
    expect(told).not.toContain("final acceptance");
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
  } finally { await f.close(); }
});

it("shows the repair's acceptance test next while product checks run before it and while a failed check is repaired first", async () => {
  const f = await fixture({ gate: true });
  const held = join(f.root, "check-held"), release = join(f.root, "check-release"), failed = join(f.root, "check-failed");
  try {
    const [first] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    // The first product's check, once its repair is in place, waits for the test's release and then fails once.
    const script = join(f.root, "check.js");
    writeFileSync(script, `const fs = require("fs");
if (fs.existsSync("welcome.txt") && !fs.existsSync(${JSON.stringify(failed)})) {
  fs.writeFileSync(${JSON.stringify(held)}, "");
  const started = Date.now();
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() - started < 60000) Bun.sleepSync(20);
  fs.writeFileSync(${JSON.stringify(failed)}, "");
  process.exit(1);
}
`);
    f.engine.setProductChecks(first, [{ name: "Test", command: commandInputText([process.execPath, script]) }]);
    const read = () => {
      const state = f.engine.getState(), shown = state.tasks.find(task => task.id === f.task.id)!;
      return [nextLine(state, shown), journeyView(shown, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter(node => ["now", "next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`)];
    };
    const driving = f.drive(task => task.repair?.kind === "checks");
    void driving.catch(() => undefined);
    await waitFor(() => existsSync(held), "the product check before the repair's acceptance test", undefined, { during: driving });
    // Petrina's own checks run before the repair's test: that test is still next, then the owed reviews.
    expect(f.task.repairCheck).toBe(true);
    expect(read()).toEqual(["Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)",
      ["Automated checks (again): now", "Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    writeFileSync(release, "");
    await driving;
    // The check failed, so the Builder repairs it first; the repair's test still follows, before the reviews.
    expect(f.task.repair?.kind).toBe("checks");
    expect(f.task.repairCheck).toBe(true);
    f.engine.pause(f.task.id);
    expect(read()).toEqual(["Next: fixes by the builder (Codex · sol), then acceptance testing of the repair (Claude Code · Opus 5.5)",
      ["Builder (fixes 2): next", "Tester (again): ahead", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    f.engine.resume(f.task.id);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
  } finally { try { writeFileSync(release, ""); } finally { await f.close(); } }
});

it("returns final testing's repair straight to the same delivery check after the reviews, across a restart, without another review round", async () => {
  const f = await fixture({ gate: true });
  try {
    const [first] = f.ids;
    // Acceptance passes first; a review fix changes the code; final testing then finds a failure, and its repair passes.
    f.responses.configure({ builder: "plain", fixes: "change", reviewer: "important", affectedProducts: [first], testerRuns: [[passed([first])], [failing([first])], [passed([first])]] });
    await f.drive(task => task.repair?.kind === "acceptance");
    expect(f.order()).toEqual(["test", "review", "build:1", "review", "security", "test"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(FINAL_TEST);
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance", final: true });
    await f.restart();
    expect(f.task.repair?.final).toBe(true);
    const reviewed = f.seats();
    await f.drive();
    // The repaired final code gets its final test, then the same delivery check: no review repeats, one decision.
    expect(f.order()).toEqual(["test", "review", "build:1", "review", "security", "test", "build:1", "test", "decision"]);
    expect(f.runs("tester")[2]!.trigger?.reason).toBe(FINAL_TEST);
    expect(f.responses.openings("tester").at(-1)!).toContain("This is final acceptance testing after review.");
    expect(f.seats()).toEqual(reviewed);
    expect(f.task.rounds[f.review.id]).toBe(2);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["fixed"]);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.decisions()).toHaveLength(1);
    expect(f.decisions()[0]!.title).toBe("Ready to ship “Show the greeting”");
  } finally { await f.close(); }
});
