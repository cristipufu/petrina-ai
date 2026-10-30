import { afterAll, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { acceptanceRepairFixtures, failing, passed, REPAIR_CHECK, FINAL_TEST, ALL_SEATS } from "../../fixtures/acceptance-repairs.js";

const { fixture, close: closeFixtures } = acceptanceRepairFixtures();
afterAll(closeFixtures);

// Policy permutations use actual portable controllers; these anchors retain real context, Git and restart/retry boundaries.
for (const continued of [true]) it(`repairs an independent review finding on its own product only, without handing over a used-up acceptance failure${continued ? " to a Builder continuing its conversation" : ""}`, async () => {
  const f = await fixture({ gate: true });
  try {
    const [first, second] = f.ids;
    // A failure owned by both products uses up both returns; then a reviewer raises an Important finding on the first product.
    f.responses.configure({ builder: "plain", reviewer: "important", affectedProducts: [first], testerChecks: [failing([first, second])], ...(continued ? { reopen: "resume" as const } : {}) });
    const before = await f.mains();
    // Native persistence/retry anchor for an early repair, before any repair Builder is admitted.
    await f.drive(task => task.repair?.kind === "acceptance");
    const early = structuredClone(f.task.repair);
    expect(early).toEqual({ products: [first, second], index: 0, returnStage: 1, kind: "acceptance" });
    expect(early?.final).toBeUndefined();
    await f.restart();
    expect(f.task.repair).toEqual(early);
    f.engine.fail(f.task.id, new Error("The Builder's tool stopped answering"));
    await f.engine.retry(f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "stuck")!.id);
    expect(f.task.repair).toEqual(early);
    expect(f.task.repair?.final).toBeUndefined();
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
    for (const role of ["code-reviewer", "security-reviewer"]) expect(f.responses.prompts(role).some(text => text.includes(held!.id))).toBe(false);
    // The actual early Tester heard repair-before-review instructions; final testing has its own native anchor.
    const told = f.responses.openings(f.tester)[1]!;
    expect(told).toContain("This acceptance run checks the builder's repair of an earlier run that did not pass, before review.");
    expect(told).toContain("This run checks the builder's repair of the prior acceptance run, which did not pass; the planned reviews follow.");
    expect(told).not.toContain("final acceptance");
    expect(f.runs(f.tester)[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(await f.mains()).toEqual(before);
    expect(f.task.repositories!.every(work => !work.landed)).toBe(true);
    // Approval/publication retains the real two-product Git oracle for the portable policy cases.
    f.engine.approve(f.decisions()[0]!.id);
    await f.drive();
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect((await f.mains()).every((sha, index) => sha !== before[index])).toBe(true);
  } finally { await f.close(); }
});

it("returns final testing's repair straight to the same delivery check after the reviews, across a restart, without another review round", async () => {
  const f = await fixture({ gate: true, acceptedBuilds: true });
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
