import { describe as originalDescribe } from "vitest";
import type { DeepMutable, CheckEvidenceTask } from "../../../src/index.js";
import { expect, it } from "vitest";
import { namedCheckFailures, relatedCheckCandidates } from "../../../src/related-check-evidence.js";
import { copyEvidence, failureName, commands, sha, failure, peer, matches, bunSummary } from "../../fixtures/related-check-evidence.js";

originalDescribe("related check evidence", () => {
it("recognises suite names with runner formatting and durations while preserving meaningful numbers and file identity", () => {
    expect(namedCheckFailures(`@petrina/engine test | test/review.test.ts:\n@petrina/engine test | (fail) suite 2 > retry 3 [29.001ms]\nAssertionError: arbitrary prose\nerror: 1 failed`)).toEqual([{ name: "suite 2 > retry 3", file: "test/review.test.ts" }]);
    expect(namedCheckFailures("FAIL test/review.test.ts > suite 2 > retry 3 (1.2 s)\n(fail) standalone\nexited with code 1")).toEqual([{ name: "suite 2 > retry 3", file: "test/review.test.ts" }]);
    expect(namedCheckFailures(Array.from({ length: 10 }, (_, i) => `(fail) suite > test ${i} [1ms]`).join("\n"))).toHaveLength(6);
    expect(namedCheckFailures("(fail) suite > " + "x".repeat(1100))).toEqual([]);
    expect(namedCheckFailures("(fail) suite 2 > deadline 30ms")).toEqual([{ name: "suite 2 > deadline 30ms" }]);
  });
});

originalDescribe("related check evidence", () => {
it("links end-of-run failures without borrowing the last file, including when only the saved tail remains", () => {
    const p = peer(); const own = failure("j3");
    const output = (lastFile: string, duration: string) => `test/review.test.ts:\n(fail) ${failureName} [${duration}]\n${"padding".repeat(1000)}\n${bunSummary(lastFile, duration)}`;
    const first = output("test/screen.test.ts", "2869.28ms");
    const second = output("test/setup.test.ts", "2512.40ms");
    expect(namedCheckFailures(first)).toEqual([{ name: failureName, file: "test/review.test.ts" }]);
    expect(namedCheckFailures(second)).toEqual([{ name: failureName, file: "test/review.test.ts" }]);
    p.journey[0]!.productChecks![0]!.namedFailures = namedCheckFailures(first.slice(-6000));
    own.check.namedFailures = namedCheckFailures(second.slice(-6000));
    expect(own.check.namedFailures).toEqual([{ name: failureName }]);
    expect(matches(p, own)[0]!.names).toEqual([failureName]);
    // Older diagnostics also retain only the summary, without recorded file identity.
    own.check.namedFailures = undefined; own.check.detail = bunSummary("test/other.test.ts", "10ms");
    expect(matches(p, own)[0]!.names).toEqual([failureName]);
  });
});

originalDescribe("related check evidence", () => {
it("retains known file distinctions and does not spend the name limit on summary repetitions", () => {
    const output = (file: string) => `${file}:\n(fail) ${failureName} [1ms]\n${bunSummary("test/unrelated.test.ts", "1ms")}`;
    const own = failure(); own.check.namedFailures = namedCheckFailures(output("test/first.test.ts"));
    const p = peer(); p.journey[0]!.productChecks![0]!.namedFailures = namedCheckFailures(output("test/second.test.ts"));
    expect(own.check.namedFailures).toEqual([{ name: failureName, file: "test/first.test.ts" }]);
    expect(matches(p, own)).toEqual([]);
    expect(namedCheckFailures(`test/first.test.ts:\n(fail) ${failureName}\n${output("test/second.test.ts")}`)).toEqual([
      { name: failureName, file: "test/first.test.ts" }, { name: failureName, file: "test/second.test.ts" },
    ]);
    const inline = Array.from({ length: 5 }, (_, i) => `(fail) suite 2 > test ${i} [1ms]`).join("\n");
    const summary = Array.from({ length: 6 }, (_, i) => `(fail) suite 2 > test ${i} [2ms]`).join("\n");
    expect(namedCheckFailures(`test/first.test.ts:\n${inline}\ntest/last.test.ts:\n(pass) suite > passes\n6 tests failed:\n${summary}`)).toEqual([
      ...Array.from({ length: 5 }, (_, i) => ({ name: `suite 2 > test ${i}`, file: "test/first.test.ts" })),
      { name: "suite 2 > test 5" },
    ]);
  });
});

originalDescribe("related check evidence", () => {
it("links the j5 and j3 grouped-review evidence despite timing and task-specific hook differences", () => {
    const result = matches(peer());
    expect(result).toHaveLength(1);
    expect(result[0]!.names).toEqual([failureName]);
    expect(result[0]!.status).toBe("claimed");
    const second = peer("task-59519"); second.journey[0]!.id = "j3"; second.journey[1]!.checkRepairs![0]!.failureNode = "j3";
    expect(matches(second, failure("j5"))).toHaveLength(1);
  });
});

originalDescribe("related check evidence", () => {
it("excludes confirmed interrupted peer failures while preserving their original reports", () => {
    const p = peer(), own = failure("j3");
    expect(matches(p, own)).toHaveLength(1);
    const check = p.journey[0]!.productChecks![0]!;
    const original = { result: check.result, output: check.run!.output };
    check.run!.interruption = { source: "macOS power log", at: 1, event: "Entering Sleep state" };
    expect(matches(p, own)).toEqual([]);
    expect({ result: check.result, output: check.run!.output }).toEqual(original);
  });
});

originalDescribe("related check evidence", () => {
it("requires the same product, failing command, command list and specific overlapping name", () => {
    for (const change of [
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.checkAttempts![0]!.productId = "other"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.run!.command = "bun run other"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.checkAttempts![0]!.commands.push("bun run build"); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.detail = "(fail) another suite > another test [1ms]"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.detail = "AssertionError: identical arbitrary prose"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.result = "did-not-finish"; },
    ]) { const p = peer(); change(p); expect(matches(p)).toEqual([]); }
    const own = failure(); own.check.namedFailures = [{ name: "suite > attempt 2", file: "first.test.ts" }];
    const p = peer(); p.journey[0]!.productChecks![0]!.namedFailures = [{ name: "suite > attempt 3", file: "first.test.ts" }];
    expect(matches(p, own)).toEqual([]);
    p.journey[0]!.productChecks![0]!.namedFailures = [{ name: "suite > attempt 2", file: "second.test.ts" }];
    expect(matches(p, own)).toEqual([]);
    p.journey[0]!.productChecks![0]!.namedFailures = [{ name: "suite > attempt 2" }];
    expect(matches(p, own)).toHaveLength(1);
    p.journey[0]!.productChecks![0]!.name = "Renamed test check";
    expect(matches(p, own)).toHaveLength(1);
    const partial = `(fail) suite > ${"x".repeat(300)}`;
    p.journey[0]!.productChecks![0]!.namedFailures = undefined;
    p.journey[0]!.productChecks![0]!.detail = `${"e".repeat(999 - partial.length)}\n${partial}`;
    own.check.namedFailures = [{ name: `suite > ${"x".repeat(300)}` }];
    expect(matches(p, own)).toEqual([]);
  });
});

originalDescribe("related check evidence", () => {
it("attaches passing checks and review only to the snapshot their saved evidence names", () => {
    const p = peer();
    p.journey.push({ id: "j7", kind: "petrina", startedAt: 5, endedAt: 6, end: "done", checkAttempts: [{ id: "run-0", productId: "p", sha: sha("e"), tree: sha("e"), commands: [...commands], definition: "candidate-hooks", passed: true }] });
    expect(matches(p)[0]!.status).toBe("claimed");
    p.journey[2]!.checkAttempts![0]!.tree = sha("d");
    p.journey[2]!.checkAttempts![0]!.definition = "new-hook-inputs";
    expect(matches(p)[0]!.status).toBe("claimed");
    p.journey[2]!.checkAttempts![0]!.definition = "candidate-hooks";
    expect(matches(p)[0]!.status).toBe("checked");
    p.journey[1]!.checkRepairs![0]!.commands.push("bun run build");
    expect(matches(p)[0]!.status).toBe("claimed");
    p.journey[2]!.checkAttempts![0]!.commands.push("bun run build");
    expect(matches(p)[0]!.status).toBe("checked");
    p.journey[2]!.checkAttempts![0]!.passed = false;
    expect(matches(p)[0]!.status).toBe("claimed");
    p.journey[2]!.checkAttempts![0]!.passed = true;
    p.journey.push({ id: "j8", kind: "agent", startedAt: 7, endedAt: 8, end: "done" });
    expect(matches(p)[0]!.status).toBe("checked");
    p.journey[3]!.checkReviews = [{ productId: "p", tree: sha("e"), at: 8, stageId: "review", round: 1 }];
    expect(matches(p)[0]!.status).toBe("checked");
    p.journey[3]!.checkReviews![0]!.tree = sha("d");
    expect(matches(p)[0]!.status).toBe("reviewed");
  });
});

originalDescribe("related check evidence", () => {
it("omits uncertain associations, reused findings, unfinished and superseded candidates", () => {
    for (const change of [
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.checkRepairs![0]!.failureNode = "new-failure"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.checkRepairs![0]!.attemptId = "run-1"; },
      (p: DeepMutable<CheckEvidenceTask>) => { delete p.journey[1]!.endedAt; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.end = "cancelled"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.findingId = "reassigned"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ id: "update", kind: "agent", startedAt: 5, endedAt: 6, end: "done", buildVersions: { p: sha("e") } }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ id: "ongoing", kind: "agent", startedAt: 5, buildProductId: "p" }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ ...copyEvidence(p.journey[0]!), id: "new-failure", startedAt: 5, endedAt: 6 }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ ...copyEvidence(p.journey[0]!), id: "new-failure", startedAt: 5, endedAt: 6 }); p.journey[1]!.checkRepairs![0]!.failureNode = "new-failure"; },
      (p: DeepMutable<CheckEvidenceTask>) => { delete p.journey[0]!.checkAttempts; },
    ]) { const p = peer(); change(p); expect(matches(p)).toEqual([]); }
    for (const state of ["paused", "cancelled", "done", "failed"] as const) { const p = peer(); p.state = state; expect(matches(p)).toEqual([]); }
    const held = peer(); held.held = true; expect(matches(held)).toEqual([]);
    held.delivery = { sha: sha("e"), tree: sha("f"), repo: "acme/p", branch: "main", at: 10 };
    expect(matches(held)[0]!.active).toBe(false);
    expect(matches(held)[0]!.status).toBe("claimed");
    expect(matches(held)[0]!.delivery!.tree).toBe(sha("f"));
  });
});

originalDescribe("related check evidence", () => {
it("reserves the newest active leads while keeping delivery lookups bounded", () => {
    const peers = Array.from({ length: 48 }, (_, i) => {
      const p = peer(`peer-${i}`); p.journey[1]!.endedAt = i + 4;
      if (i < 32) { p.state = "done"; p.delivery = { sha: sha("e"), tree: sha("f"), repo: "acme/p", branch: "main", at: 100 }; }
      return p;
    });
    const candidates = relatedCheckCandidates([failure()], peers, "p");
    expect(candidates.filter((candidate) => candidate.delivery)).toHaveLength(8);
    expect(candidates.filter((candidate) => candidate.active).map((candidate) => candidate.taskId)).toEqual(["peer-47", "peer-46", "peer-45"]);
    expect(candidates[0]!.taskId).toBe("peer-31");
  });
});
