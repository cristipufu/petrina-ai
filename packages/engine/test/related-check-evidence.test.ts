import type { CheckEvidenceTask } from "@petrina/core";
import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { beginAgentStep, createDemoState, openStep, type DeepMutable, type Task } from "@petrina/core";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { TaskHistory } from "@petrina/storage/history-store";
import { assignedCheckFailures, deliveryMissing, namedCheckFailures, projectCheckEvidence, relatedCheckCandidates, type CheckFailureReference } from "../src/related-check-evidence.js";
import { executionFor } from "@petrina/orchestrator";
import { git, makeWorld, removeDir, tempDir } from "./support.js";

const failureName = "real grouped review summaries > credits a grouped review's replacement and excludes the handed-over step from timing history";
const commands = ["bun run typecheck", "bun run test"];
const sha = (letter: string) => letter.repeat(40);
const immutableTask = createDemoState(1_000_000).tasks[0]!;
function failure(nodeId = "j5", duration = "22.91ms"): DeepMutable<CheckFailureReference> {
  return { nodeId, attempt: { id: "run-0", productId: "p", sha: sha("a"), tree: sha("b"), definition: "failure-hooks", commands: [...commands] },
    check: { id: "check-1", attemptId: "run-0", productId: "p", findingId: "f1", name: "Tests", result: "fail", detail: `(fail) ${failureName} [${duration}]`,
      run: { name: "Tests", command: "bun run test", ok: false, ms: 25, output: "captured failure", logPath: "/missing-check.log" } } };
}
function peer(id = "task-58913"): DeepMutable<CheckEvidenceTask> {
  const f = failure();
  return { id, state: "running", held: false, journey: [
    { id: "j5", kind: "petrina", startedAt: 1, endedAt: 2, end: "done", productChecks: [f.check], checkAttempts: [f.attempt] },
    { id: "j6", kind: "agent", startedAt: 3, endedAt: 4, end: "done", buildVersions: { p: sha("d") }, checkRepairs: [{ productId: "p", failureNode: "j5", checkId: "check-1", attemptId: "run-0", findingId: "f1", sha: sha("c"), tree: sha("d"), definition: "candidate-hooks", commands: [...commands], answer: { fixed: true, text: "Waited for replacement-owned progress before checking the summary." } }] },
  ] };
}
const matches = (p: CheckEvidenceTask, own = failure("j3", "1099.27ms")) => relatedCheckCandidates([own], [p], "p");
function bunSummary(lastFile: string, duration: string) {
  return [`test/first.test.ts:`, `(pass) another suite > first passing test [1ms]`,
    `${lastFile}:`, `(pass) another suite > last passing test [1ms]`,
    "1 tests failed:", `(fail) ${failureName} [${duration}]`, "2 pass", "1 fail",
  ].map((line) => `@petrina/engine:test  | ${line}`).join("\n");
}
function archived(p: CheckEvidenceTask): Task {
  return { ...structuredClone(immutableTask), id: p.id, productId: "p", state: "done", held: false, finishedAt: 10, repositories: undefined,
    repository: { productId: "p", delivery: "local", confirmedDelivery: p.delivery },
    description: "PRIVATE REQUEST", session: [{ id: "line", at: 1, from: "agent", text: "PRIVATE CONVERSATION" }],
    journey: p.journey.map((step) => ({ ...step, round: 1, sub: 0, agentInputs: [{ roleId: "builder", profileId: "profile", mode: "fresh", taskTitle: "PRIVATE TITLE", sections: [{ title: "PRIVATE PROMPT", body: "PRIVATE PLAN" }] }], agentResults: [{ roleId: "builder", profileId: "profile", at: 4, value: { summary: "PRIVATE FULL REPORT" } }], result: { findings: [{ id: "secret", raisedBy: "reviewer", confirmedBy: [], status: "open", severity: "blocking", text: "PRIVATE REVIEW" }] } })) };
}

describe("related check evidence", () => {
  it("recognises suite names with runner formatting and durations while preserving meaningful numbers and file identity", () => {
    expect(namedCheckFailures(`@petrina/engine test | test/review.test.ts:\n@petrina/engine test | (fail) suite 2 > retry 3 [29.001ms]\nAssertionError: arbitrary prose\nerror: 1 failed`)).toEqual([{ name: "suite 2 > retry 3", file: "test/review.test.ts" }]);
    expect(namedCheckFailures("FAIL test/review.test.ts > suite 2 > retry 3 (1.2 s)\n(fail) standalone\nexited with code 1")).toEqual([{ name: "suite 2 > retry 3", file: "test/review.test.ts" }]);
    expect(namedCheckFailures(Array.from({ length: 10 }, (_, i) => `(fail) suite > test ${i} [1ms]`).join("\n"))).toHaveLength(6);
    expect(namedCheckFailures("(fail) suite > " + "x".repeat(1100))).toEqual([]);
    expect(namedCheckFailures("(fail) suite 2 > deadline 30ms")).toEqual([{ name: "suite 2 > deadline 30ms" }]);
  });

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

  it("links the j5 and j3 grouped-review evidence despite timing and task-specific hook differences", () => {
    const result = matches(peer());
    expect(result).toHaveLength(1);
    expect(result[0]!.names).toEqual([failureName]);
    expect(result[0]!.status).toBe("claimed");
    const second = peer("task-59519"); second.journey[0]!.id = "j3"; second.journey[1]!.checkRepairs![0]!.failureNode = "j3";
    expect(matches(second, failure("j5"))).toHaveLength(1);
  });

  it("excludes confirmed interrupted peer failures while preserving their original reports", () => {
    const p = peer(), own = failure("j3");
    expect(matches(p, own)).toHaveLength(1);
    const check = p.journey[0]!.productChecks![0]!;
    const original = { result: check.result, output: check.run!.output };
    check.run!.interruption = { source: "macOS power log", at: 1, event: "Entering Sleep state" };
    expect(matches(p, own)).toEqual([]);
    expect({ result: check.result, output: check.run!.output }).toEqual(original);
  });

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

  it("omits uncertain associations, reused findings, unfinished and superseded candidates", () => {
    for (const change of [
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.checkRepairs![0]!.failureNode = "new-failure"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.checkRepairs![0]!.attemptId = "run-1"; },
      (p: DeepMutable<CheckEvidenceTask>) => { delete p.journey[1]!.endedAt; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[1]!.end = "cancelled"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey[0]!.productChecks![0]!.findingId = "reassigned"; },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ id: "update", kind: "agent", startedAt: 5, endedAt: 6, end: "done", buildVersions: { p: sha("e") } }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ id: "ongoing", kind: "agent", startedAt: 5, buildProductId: "p" }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ ...structuredClone(p.journey[0]!), id: "new-failure", startedAt: 5, endedAt: 6 }); },
      (p: DeepMutable<CheckEvidenceTask>) => { p.journey.push({ ...structuredClone(p.journey[0]!), id: "new-failure", startedAt: 5, endedAt: 6 }); p.journey[1]!.checkRepairs![0]!.failureNode = "new-failure"; },
      (p: DeepMutable<CheckEvidenceTask>) => { delete p.journey[0]!.checkAttempts; },
    ]) { const p = peer(); change(p); expect(matches(p)).toEqual([]); }
    for (const state of ["paused", "cancelled", "done", "failed"] as const) { const p = peer(); p.state = state; expect(matches(p)).toEqual([]); }
    const held = peer(); held.held = true; expect(matches(held)).toEqual([]);
    held.delivery = { sha: sha("e"), tree: sha("f"), repo: "acme/p", branch: "main", at: 10 };
    expect(matches(held)[0]!.active).toBe(false);
    expect(matches(held)[0]!.status).toBe("claimed");
    expect(matches(held)[0]!.delivery!.tree).toBe(sha("f"));
  });

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

  it("reads bounded, product-scoped evidence after restart without loading private task material", () => {
    const folder = tempDir("related-history-"); const file = join(folder, "history.db");
    let db = new Database(file);
    try {
      const history = new TaskHistory(db);
      history.put(Array.from({ length: 30 }, (_, i) => {
        const p = peer(`peer-${i}`); p.delivery = { sha: sha("e"), tree: sha("f"), repo: "acme/p", branch: "main", at: 10 };
        return archived(p);
      }));
      db.close(); db = new Database(file);
      const loaded = new TaskHistory(db);
      const records = loaded.checkEvidence("p");
      expect(records).toHaveLength(24);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
      expect(loaded.checkEvidence("other")).toEqual([]);
      expect(records[0]!.journey[0]!.id).toBe("j5");
      expect(records[0]!.journey[1]!.checkRepairs![0]!.tree).toBe(sha("d"));
      expect(records[0]!.delivery!.sha).toBe(sha("e"));
      expect(matches({ ...records[0]!, state: "running" })[0]!.status).toBe("claimed");
    } finally { db.close(); removeDir(folder); }
  });

  it("uses the actual prepared history after updates, never the original starting commit or short labels", async () => {
    const w = await makeWorld("related-delivery");
    try {
      await git(w.clone, "checkout", "-q", "-b", "delivery");
      writeFileSync(join(w.clone, "repair.txt"), "replacement progress");
      await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Repair progress");
      const delivered = await git(w.clone, "rev-parse", "HEAD");
      const delivery = { sha: delivered, tree: await git(w.clone, "rev-parse", "HEAD^{tree}"), repo: "acme/p", branch: "main", at: 10 };
      await git(w.clone, "checkout", "-q", "main");
      writeFileSync(join(w.clone, "feature.txt"), "feature"); await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Build feature");
      expect(await deliveryMissing(w.clone, "acme/p", delivery)).toBe(true);
      expect(await deliveryMissing(w.clone, "acme/p", { ...delivery, sha: delivered.slice(0, 7) })).toBe(false);
      expect(await deliveryMissing(w.clone, "acme/p", { ...delivery, sha: sha("f") })).toBe(false);
      expect(await deliveryMissing(w.clone, "other/p", delivery)).toBe(false);
      expect(await deliveryMissing(w.clone, "acme/p", { ...delivery, tree: sha("f") })).toBe(false);
      await git(w.clone, "merge", "--no-edit", "delivery");
      expect(await deliveryMissing(w.clone, "acme/p", delivery)).toBe(false);
      expect(w.initial).not.toBe(delivered);
    } finally { removeDir(w.dir); }
  });

  it("records failure ownership and the completed Builder's answer, without borrowing a later pass after an update", async () => {
    const w = await makeWorld("related-recording");
    const engine = w.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.schedule = () => {}; engine.setPoolPaused(false);
    const turn = spyOn(engine["turns"], "turn");
    try {
      const check = { name: "Tests", argv: [process.execPath, "-e", `if (!require('fs').existsSync('repair.txt')) { console.log(${JSON.stringify(`(fail) ${failureName} [5ms]`)}); process.exit(1); }`] };
      engine.s.products.push({ id: "p", name: "Product", repo: "acme/p", path: w.clone, tone: "blue", checksBy: "coordinator", checks: [check] });
      const id = engine.addTask({ productId: "p", title: "Repair the progress fixture", backlog: true });
      const task = engine.task(id)!; task.state = "running";
      const scope = executionFor(task);
      await git(w.clone, "checkout", "-qb", "repair");
      Object.assign(scope.work, { worktree: w.clone, baseSha: w.initial, base: "main", branch: "repair" });
      const stage = { id: "build", title: "Repair", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
      task.plan = { rationale: "Repair", plannerProfileId: "sol-high", stages: [stage] };
      engine["checks"].claimPreparation(id);
      const signal = new AbortController().signal;
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(1);
      task.fixing = true;
      const failures = assignedCheckFailures(scope);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.check.namedFailures![0]!.name).toBe(failureName);
      const original = task.journey!.find((step) => step.id === failures[0]!.nodeId)!.productChecks![0]!;
      const originalReport = { result: original.result, output: original.run!.output };
      original.run!.interruption = { source: "macOS power log", at: Date.now(), event: "Entering Sleep state" };
      expect(assignedCheckFailures(scope)).toEqual([]);
      expect({ result: original.result, output: original.run!.output }).toEqual(originalReport);
      delete original.run!.interruption;
      expect(assignedCheckFailures(scope)).toHaveLength(1);
      const findingId = failures[0]!.check.findingId!;
      beginAgentStep(task, "builder", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
      const value = { summary: "Repaired progress", changes: ["Wait for owned progress"], title: "Repair progress", answers: [{ id: findingId, fixed: true, text: "Wait for replacement-owned progress." }], learnings: [] };
      turn.mockImplementation(async () => {
        writeFileSync(join(w.clone, "repair.txt"), "replacement progress");
        openStep(task)!.agentResults = [{ roleId: "builder", profileId: "sol-high", at: Date.now(), value }];
        return value as never;
      });
      await engine["work"].runDo(scope, stage, signal);
      const candidate = task.journey!.findLast((step) => step.checkRepairs?.length)!.checkRepairs![0]!;
      expect(candidate.findingId).toBe(findingId);
      expect(candidate.failureNode).toBe(failures[0]!.nodeId);
      expect(candidate.answer.text).toBe(value.answers[0]!.text);
      expect(candidate.tree).toBe(await git(w.clone, "rev-parse", "HEAD^{tree}"));
      const candidateSha = await git(w.clone, "rev-parse", "HEAD");
      writeFileSync(join(w.clone, "update.txt"), "new base contents"); await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Update from main");
      engine["checks"].claimPreparation(id);
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(0);
      expect(task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(true);
      expect(relatedCheckCandidates(failures, [projectCheckEvidence(task, "p")!], "p")[0]!.status).toBe("claimed");
      await git(w.clone, "reset", "--hard", candidateSha);
      engine["checks"].claimPreparation(id);
      expect(await engine["checks"].runProductChecks(scope, [check], signal)).toBe(0);
      expect(relatedCheckCandidates(failures, [projectCheckEvidence(task, "p")!], "p")[0]!.status).toBe("checked");
      expect(task.findings.find((finding) => finding.id === findingId)!.status).toBe("fixed");
      expect(scope.work.checkReturns).toBeUndefined();
      // Even an original exit-zero report cannot certify a repair when verification was interrupted.
      for (const ok of [false, true]) {
        const interrupted = { ...scope.work.checks!.results[0]!, ok, output: "Original reported result retained", interruption: { source: "macOS power log" as const, at: Date.now(), event: "Entering Sleep state" } };
        scope.work.checkReturns = 2;
        engine["checks"].claimPreparation(id);
        expect(await engine["checks"].runProductChecks(scope, [check], signal, [interrupted])).toBe(1);
        const recorded = task.journey!.at(-1)!;
        expect(recorded.checkAttempts![0]!.passed).not.toBe(true);
        expect(recorded.outcome).toBe("Interrupted — verification incomplete");
        expect(recorded.productChecks![0]!.run!.output).toBe(interrupted.output);
        expect(scope.work.checkReturns).toBe(2);
      }
    } finally { turn.mockRestore(); await engine.shutdown(); removeDir(w.dir); }
  });

  it("shows at most three compact leads to added Builder roles and keeps fresh and continued review blind", async () => {
    const w = await makeWorld("related-context");
    const engine = w.start({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.setPoolPaused(true); engine.schedule = () => {};
    try {
      engine.s.products.push({ id: "p", name: "Product", repo: "acme/p", path: w.clone, tone: "blue", checksBy: "coordinator", checks: [{ name: "Types", argv: ["bun", "run", "typecheck"] }, { name: "Tests", argv: ["bun", "run", "test"] }] });
      const ownId = engine.addTask({ productId: "p", title: "Own repair", backlog: true });
      const task = engine.task(ownId)!; const scope = executionFor(task);
      const own = failure("j3");
      task.fixing = true; task.journey = [{ id: "j3", kind: "petrina", round: 1, sub: 0, startedAt: 1, endedAt: 2, end: "done", productChecks: [own.check], checkAttempts: [own.attempt] }];
      task.findings = [{ id: "f1", text: "Check failed: Tests (bun run test)", raisedBy: "petrina", confirmedBy: [], status: "open", severity: "blocking" }];
      scope.work.worktree = w.clone; scope.work.checks = { at: 2, provenance: { nodeId: "j3", attemptId: "run-0" }, results: [own.check.run] };
      for (let i = 0; i < 5; i++) {
        const id = engine.addTask({ productId: "p", title: "PRIVATE PEER REQUEST", backlog: true });
        const other = engine.task(id)!; other.state = "running";
        const p = peer(id); other.journey = p.journey.map((step) => ({ ...step, round: 1, sub: 0 }));
        executionFor(other).work.report = { summary: "PRIVATE FULL REPORT", changes: [] };
      }
      engine.s.roles.push({ ...engine.role("builder")!, id: "added-builder", name: "Repair builder" });
      const sections = await engine["context"].sectionsFor(scope, "added-builder");
      const section = sections.find((section) => section.title === "Related check evidence")!;
      expect(section.body.match(/Shared named failure:/g)).toHaveLength(3);
      expect(section.body).toContain("claimed for commit");
      expect(section.body).toContain("snapshot unavailable");
      expect(section.body).toContain("/missing-check.log");
      expect(section.body).not.toContain("PRIVATE");
      expect(section.body.length).toBeLessThan(6500);
      const review = await engine["context"].captureReview(scope);
      expect(JSON.stringify(review)).not.toContain("Related check evidence");
      for (const role of engine.s.roles.filter((role) => role.result !== "build")) {
        const fresh = await engine["context"].sectionsFor(scope, role.id);
        expect(fresh.some((section) => section.title === "Related check evidence")).toBe(false);
        const continued = await engine["context"].sectionsFor(scope, role.id, undefined, undefined, undefined, review);
        expect(continued.some((section) => section.title === "Related check evidence")).toBe(false);
      }
      const unavailable = spyOn(engine.store.history, "checkEvidence").mockImplementation(() => { throw new Error("History unavailable"); });
      try {
        const fallback = await engine["context"].sectionsFor(scope, "added-builder");
        expect(fallback.some((section) => section.title === "Related check evidence")).toBe(false);
        expect(fallback.some((section) => section.title.startsWith("Review findings"))).toBe(true);
      } finally { unavailable.mockRestore(); }
      const deliveredPeer = engine.s.tasks.find((other) => other.id !== task.id)!;
      deliveredPeer.state = "done";
      scope.work.baseSha = w.initial;
      await git(w.clone, "checkout", "-qb", "landed-lead");
      writeFileSync(join(w.clone, "landed-repair.txt"), "confirmed delivered contents");
      await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Deliver the related repair");
      const deliveredSha = await git(w.clone, "rev-parse", "HEAD"), deliveredTree = await git(w.clone, "rev-parse", "HEAD^{tree}");
      executionFor(deliveredPeer).work.confirmedDelivery = { sha: deliveredSha, tree: deliveredTree, repo: "acme/p", branch: "main", at: 10 };
      await git(w.clone, "checkout", "-q", "main");
      const missing = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
      expect(missing).toContain("Separately confirmed landed contents");
      expect(missing).toContain(deliveredSha);
      expect(missing.indexOf(`Task ${deliveredPeer.id};`)).toBeLessThan(missing.indexOf(`Task ${engine.s.tasks[2]!.id};`));
      await git(w.clone, "merge", "--ff-only", "landed-lead");
      const included = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
      expect(included).not.toContain(`Task ${deliveredPeer.id};`);
      expect(included).not.toContain("Separately confirmed landed contents");
      expect(scope.work.baseSha).toBe(w.initial);
      const initialTree = await git(w.clone, "rev-parse", `${w.initial}^{tree}`);
      for (let i = 0; i < 7; i++) {
        const id = engine.addTask({ productId: "p", title: "Already delivered peer", backlog: true });
        const other = engine.task(id)!; other.state = "done";
        other.journey = peer(id).journey.map((step) => ({ ...step, round: 1, sub: 0 }));
        executionFor(other).work.confirmedDelivery = { sha: w.initial, tree: initialTree, repo: "acme/p", branch: "main", at: 10 };
        // Seven and eight included deliveries must both leave room for active repairs.
        if (i < 5) continue;
        const remaining = (await engine["context"].sectionsFor(scope, "added-builder")).find((section) => section.title === "Related check evidence")!.body;
        expect(remaining.match(/Shared named failure:/g)).toHaveLength(3);
        expect(remaining).not.toContain("Separately confirmed landed contents");
        expect(remaining).not.toContain(`Task ${deliveredPeer.id};`);
        expect(remaining).not.toContain(`Task ${id};`);
      }
      task.fixing = false;
      expect((await engine["context"].sectionsFor(scope, "added-builder")).some((section) => section.title === "Related check evidence")).toBe(false);
      task.state = "cancelled";
      const actualSha = await git(w.clone, "rev-parse", "HEAD"), actualTree = await git(w.clone, "rev-parse", "HEAD^{tree}");
      scope.work.localUpdate = { branch: "main", sha: actualSha, pushed: false };
      await engine["shipping"]["recordLanded"](scope, "main", actualSha);
      expect(scope.work.confirmedDelivery).toBeUndefined();
      scope.work.localUpdate.pushed = true;
      await engine["shipping"]["recordLanded"](scope, "main", actualSha);
      expect(scope.work.confirmedDelivery).toEqual({ sha: actualSha, tree: actualTree, repo: "acme/p", branch: "main", at: expect.any(Number) });
      expect(scope.work.landed!.sha).toBe(actualSha.slice(0, 7));
    } finally { await engine.shutdown(); removeDir(w.dir); }
  });
});
