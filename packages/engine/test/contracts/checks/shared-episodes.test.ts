import { completeAll } from "@petrina/core";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { waitForFile } from "../../support.js";
import { withRepositoryRecords, type RepositoryRecords } from "../../fixtures/shared-records.js";

describe("shared check repair episodes", () => {
  const command = (name: string, script: string) => ({ name, argv: [process.execPath, "-e", script] });
  const passing = command("Tests", "console.log('All tests pass')");
  const failing = command("Welcome page", "console.error('The welcome page is missing'); process.exit(1)");
  const setChecks = (engine: RepositoryRecords["engine"], productId: string, commands: readonly { name: string; argv: string[] }[]) => {
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





  it("recovers recorded sleep for an already waiting decision and preserves its original run across restart", async () => {
    await withRepositoryRecords("check-interruption-recovery", { git: ["first"], machineRecords: async () => "2026-10-21 17:55:44 +0300 Sleep Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 74 secs" }, async (f) => {
      let engine = f.engine;

      engine.setPoolPaused(false); f.task.plan = plan(); f.task.stageIndex = 2;
      const scope = executionFor(f.task, "first");
      setChecks(engine, "first", [failing]);
      await f.owners.run(engine, () => engine["checks"].runProductChecks(scope, [failing], engine.stopRequested.signal));
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
      await f.owners.run(engine, () => engine["checks"].restoreEvidence());
      expect(f.task.statusLine).toBe("Checks unverified. Your call");
      expect(f.task.journey).toHaveLength(count);
      expect(original.outcome).toBe(outcome);
      expect(original.productChecks![0]!.result).toBe("fail");
      expect(original.productChecks![0]!.run!.interruption?.source).toBe("macOS power log");
      expect(f.task.journey!.at(-1)!.productChecks![0]!.result).toBe("stopped");
      expect(f.task.findings[0]!.status).toBe("unverified");
      expect(scope.work.checkReturns).toBe(2);
      expect(f.task.repair).toBeUndefined();
      await f.owners.prepare(async () => { await f.owners.stop(engine); engine = f.start(); });
      const restored = engine.task(f.id)!;
      const saved = executionFor(restored, "first").work.checks!.results[0]!;
      expect(saved).toEqual(expect.objectContaining({ output, source, interruption: expect.objectContaining({ source: "macOS power log" }) }));
      expect(restored.statusLine).toBe("Checks unverified. Your call");
      expect(executionFor(restored, "first").work.checkReturns).toBe(2);

    });
  });





  it("keeps spent repairs when the required checks are replaced while a passing run is under way", async () => {
    await withRepositoryRecords("check-replaced", { git: ["first"] }, async ({ engine, task, run: ownRun }) => {

      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = engine.stopRequested.signal;
      const started = join(dirname(scope.work.worktree!), "check-started"), release = join(dirname(scope.work.worktree!), "check-release");
      const lease = await createProcessLease();
      const settle = async () => {
        await completeAll([
          Promise.resolve().then(() => writeFileSync(release, "go")),
          Promise.resolve().then(() => lease.close()),
        ]);
      };
      await setupWithCleanup(async () => {
        const holding = command("Welcome page", lease.program(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); await new Promise(resolve => { const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(wait); console.log('The welcome page works'); resolve(); } }, 20); });`));
        setChecks(engine, "first", [holding]);
        scope.work.checkReturns = 2;
        const run = ownRun(() => checks.failing(scope, signal));
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
        expect((await ownRun(() => checks.failing(scope, signal))).kind).toBe("product-failed");
        expect(task.journey!.flatMap(step => step.checkAttempts ?? [])).toHaveLength(2);
        expect(scope.work.checkReturns).toBe(2);
        // Control: a pass on the checks required now does end the episode.
        setChecks(engine, "first", [passing]);
        expect((await ownRun(() => checks.failing(scope, signal))).kind).toBe("passed");
        expect(scope.work.checkReturns).toBeUndefined();
        expect(task.journey!.at(-1)!.checkAttempts![0]!.passed).toBe(true);

      }, settle);
      await settle();

    });
  });
});
