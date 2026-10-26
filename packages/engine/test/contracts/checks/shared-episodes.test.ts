import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { removeDir, waitForFile, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("shared check repair episodes", () => {
  const command = (name: string, script: string) => ({ name, argv: [process.execPath, "-e", script] });
  const passing = command("Tests", "console.log('All tests pass')");
  const failing = command("Welcome page", "console.error('The welcome page is missing'); process.exit(1)");
  const setChecks = (engine: Awaited<ReturnType<typeof fixture>>["engine"], productId: string, commands: readonly { name: string; argv: string[] }[]) => {
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    product.checks = [...commands];
    product.checksBy = "coordinator";
  };
  const plan = () => ({ rationale: "Shared checks", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Try it", kind: "do" as const, roleId: "tester", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    { id: "delivery", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] },
    { id: "ship", title: "Commit to main", kind: "do" as const, roleId: "release-manager", profileIds: ["sol-high"] },
  ] });

  it("ends one product's failure episode on its own genuine pass, keeping the other's spent repairs", async () => {
    const { engine, task } = await fixture("check-episodes", { git: ["first","second"] });
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [passing, failing]);
      setChecks(engine, "second", [passing]);
      first.work.checkReturns = 2;
      second.work.checkReturns = 1;
      // One check fixed while another still fails continues the episode; nothing clears or extends it.
      expect(nonpassingChecks(await checks.runProductChecks(first, [passing, failing], signal))).toBe(1);
      expect(first.work.checkReturns).toBe(2);
      expect(nonpassingChecks(await checks.runProductChecks(second, [passing], signal))).toBe(0);
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBeUndefined();
      // Rereading a saved failure is no new attempt; a saved pass on the same code and definitions is a genuine pass.
      second.work.checkReturns = 1;
      expect((await checks.failing(first, signal)).kind).toBe("product-failed");
      expect((await checks.failing(second, signal)).kind).toBe("passed");
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBeUndefined();
      expect(first.work.checks!.results.map((run) => run.ok)).toEqual([true, false]);
    } finally { await engine.shutdown(); }
  });

  it("keeps confirmed interrupted evidence unverified without repairing or spending either product's allowance", async () => {
    const { engine, task } = await fixture("check-interrupted", { git: ["first","second"] });
    try {
      engine.setPoolPaused(false); task.plan = plan(); task.stageIndex = 2;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [failing]); setChecks(engine, "second", [passing]);
      await checks.runProductChecks(first, [failing], signal);
      await checks.runProductChecks(second, [passing], signal);
      first.work.checkReturns = 2; second.work.checkReturns = 1;
      const original = first.work.checks!.results[0]!;
      original.interruption = { source: "macOS power log", at: original.startedAt!, event: "Entering Sleep state due to Clamshell Sleep" };
      expect((await checks.failing(first, signal)).kind).toBe("blocked");
      expect(checks.backToBuilder(first, "before review", new Set((first.task.repositories ?? [first.work]).map(work => work.productId)))).toBe(false);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([2, 1]);
      expect(task.findings.filter((finding) => finding.status === "open")).toHaveLength(0);
      expect(task.findings[0]!.status).toBe("unverified");
      expect(checks.blocked(task)).toBe("stop");
      expect(task.statusLine).toBe("Checks unverified. Your call");
      const decision = task.journey!.at(-1)!;
      expect(decision.productChecks!.map((check) => [check.productId, check.result])).toEqual([["first", "stopped"], ["second", "pass"]]);
      expect(decision.productChecks![0]!.run!.output).toBe(original.output);
      expect(decision.productChecks![0]!.run!.source).toEqual(original.source);
    } finally { await engine.shutdown(); }
  });

  it("recovers recorded sleep for an already waiting decision and preserves its original run across restart", async () => {
    const f = await fixture("check-interruption-recovery", { git: ["first"], machineRecords: async () => "2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 74 secs" });
    let engine = f.engine;
    try {
      engine.setPoolPaused(false); f.task.plan = plan(); f.task.stageIndex = 2;
      const scope = executionFor(f.task, "first");
      setChecks(engine, "first", [failing]);
      await engine["checks"].runProductChecks(scope, [failing], new AbortController().signal);
      const run = scope.work.checks!.results[0]!;
      run.startedAt = Date.parse("2026-10-21T17:54:07+03:00"); run.endedAt = Date.parse("2026-10-21T17:57:46+03:00"); run.ms = run.endedAt - run.startedAt;
      const original = f.task.journey!.find((step) => step.id === run.source!.stepId)!;
      original.startedAt = run.startedAt; original.endedAt = run.endedAt;
      original.productChecks![0]!.run = { ...run };
      original.productChecks![0]!.startedAt = run.startedAt; original.productChecks![0]!.endedAt = run.endedAt;
      const outcome = original.outcome, output = run.output, source = { ...run.source! };
      scope.work.checkReturns = 2;
      engine["checks"].blocked(f.task);
      const count = f.task.journey!.length;
      await engine["checks"].restoreEvidence();
      expect(f.task.statusLine).toBe("Checks unverified. Your call");
      expect(f.task.journey).toHaveLength(count);
      expect(original.outcome).toBe(outcome);
      expect(original.productChecks![0]!.result).toBe("fail");
      expect(original.productChecks![0]!.run!.interruption?.source).toBe("macOS power log");
      expect(f.task.journey!.at(-1)!.productChecks![0]!.result).toBe("stopped");
      expect(f.task.findings[0]!.status).toBe("unverified");
      expect(scope.work.checkReturns).toBe(2);
      expect(f.task.repair).toBeUndefined();
      await engine.shutdown(); engine = f.start();
      const restored = engine.task(f.id)!;
      const saved = executionFor(restored, "first").work.checks!.results[0]!;
      expect(saved).toEqual(expect.objectContaining({ output, source, interruption: expect.objectContaining({ source: "macOS power log" }) }));
      expect(restored.statusLine).toBe("Checks unverified. Your call");
      expect(executionFor(restored, "first").work.checkReturns).toBe(2);
    } finally { await engine.shutdown(); }
  });

  it("opens the check problem instead of repairing a passing product for a deleted test, and bounds a real failure there", async () => {
    const { engine, task } = await fixture("check-loop", { git: ["first","second"] });
    try {
      engine.setPoolPaused(false);
      task.plan = plan();
      task.stageIndex = 2;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = new AbortController().signal;
      setChecks(engine, "first", [passing]);
      setChecks(engine, "second", [failing]);
      expect((await checks.failing(first, signal)).kind).toBe("passed");
      expect((await checks.failing(second, signal)).kind).toBe("product-failed");
      second.work.checkReturns = 2;
      // Petrina's deleted-test warning on the passing product is a blocking finding, but not a failing check.
      task.findings.push({ id: "deleted", text: "A test file was deleted: greeting.test.ts", productIds: ["first"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      const gate = async () => {
        // Each unchanged return rereads both saved results before the review gate decides.
        expect((await checks.failing(first, signal)).kind).toBe("passed");
        expect((await checks.failing(second, signal)).kind).toBe("product-failed");
        const returned = checks.backToBuilder(second, "before review", new Set((second.task.repositories ?? [second.work]).map(work => work.productId)));
        const products = task.repair?.products;
        delete task.repair;
        task.stageIndex = 2;
        return returned ? products : "blocked";
      };
      expect(await gate()).toBe("blocked");
      expect(task.findings.find((finding) => finding.id === "deleted")!.status).toBe("open");
      // Control: a real failure on the first product gets its own two returns, and then the blocker opens too.
      setChecks(engine, "first", [failing]);
      expect((await checks.failing(first, signal)).kind).toBe("product-failed");
      const turns = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await checks.failing(first, signal)).kind).toBe("product-failed");
        expect((await checks.failing(second, signal)).kind).toBe("product-failed");
        const returned = checks.backToBuilder(second, "before review", new Set((second.task.repositories ?? [second.work]).map(work => work.productId)));
        turns.push(returned ? [task.repair!.products, first.work.checkReturns] : "blocked");
        delete task.repair;
        task.stageIndex = 2;
      }
      expect(turns).toEqual([[["first"], 1], [["first"], 2], "blocked"]);
    } finally { await engine.shutdown(); }
  });

  it("ends an episode only when every check failure of the product is settled", async () => {
    const { engine, task } = await fixture("check-settled", { git: ["first"] });
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      // A pre-commit hook that failed before, and does not run on this work: the product's own checks pass.
      const hook = join(first.work.worktree!, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
      task.findings.push({ id: "hook", text: "Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)", productIds: ["first"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      setChecks(engine, "first", [passing]);
      first.work.checkReturns = 1;
      expect(nonpassingChecks(await checks.runProductChecks(first, [passing], signal))).toBe(0);
      expect(task.findings.find((finding) => finding.id === "hook")!.status).toBe("open");
      expect(first.work.checkReturns).toBe(1);
    } finally { await engine.shutdown(); }
  });

  it("keeps spent repairs when the required checks are replaced while a passing run is under way", async () => {
    const { engine, task } = await fixture("check-replaced", { git: ["first"] });
    try {
      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      const started = join(dirname(scope.work.worktree!), "check-started"), release = join(dirname(scope.work.worktree!), "check-release");
      const holding = command("Welcome page", `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(wait); console.log('The welcome page works'); } }, 20);`);
      setChecks(engine, "first", [holding]);
      scope.work.checkReturns = 2;
      const run = checks.failing(scope, signal);
      await waitForFile(started, { during: run });
      setChecks(engine, "first", [failing]);
      writeFileSync(release, "go");
      // The original pass cannot authorize continuation. The current failing requirement is
      // run within this operation, without granting any new Builder returns.
      expect((await run).kind).toBe("product-failed");
      expect(scope.work.checkReturns).toBe(2);
      const attempts = task.journey!.flatMap(step => step.checkAttempts ?? []);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.passed).toBe(false);
      expect(attempts[1]!.definition).not.toBe(attempts[0]!.definition);
      expect((await checks.failing(scope, signal)).kind).toBe("product-failed");
      expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(2);
      expect(scope.work.checkReturns).toBe(2);
      // Control: a pass on the checks required now does end the episode.
      setChecks(engine, "first", [passing]);
      expect((await checks.failing(scope, signal)).kind).toBe("passed");
      expect(scope.work.checkReturns).toBeUndefined();
      expect(task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(true);
    } finally { await engine.shutdown(); }
  });
});
