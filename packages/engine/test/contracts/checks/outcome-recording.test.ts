import type { CheckVerification } from "../../../src/product-checks.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { expect, it, spyOn } from "bun:test";
import * as nativeChecks from "@petrina/repositories/check-runner";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { join } from "node:path";
import { checkDecisionLabel, checkResult, journeyView, type CheckRun } from "@petrina/core";



import { Aborted } from "../../../src/kernel.js";
import { executionFor } from "@petrina/orchestrator";
import type { MachineRecords } from "../../../src/check-interruption.js";
import { heldMachineRecords, makeProduct, noMachineRecords, powerLogSleep, tempDir, waitFor } from "../../fixtures.js";


// Enter at check recording: no agents or unrelated planning/review workflow.

it.each(["failed", "interrupted", "mixed", "passed"] as const)("keeps %s results consistent through recording, decision and reuse", async (kind) => {
  const root = tempDir("petrina-check-outcomes-");
  const owners = directDrivers(root);
  // This engine's own sleep records: each read is counted, and a step can hold one.
  const reads: (AbortSignal | undefined)[] = [];
  let records: MachineRecords = noMachineRecords, restore: (() => void) | undefined;
  try {
    const { engine, task, scope, checks } = await setupWithCleanup(() => owners.prepare(async () => {
      const engine = owners.open(join(root, "data"), { usageCommands: { codex: null, grok: null }, agentCommand: () => undefined, terminals: () => [], machineRecords: (signal) => { reads.push(signal); return records(signal); } });
      engine.schedule = () => {};
      engine.setPoolPaused(true);
      const repo = await makeProduct(root);
      engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator" });
      const task = engine.task(engine.addTask({ productId: "product", title: "Check evidence" }))!;
      const scope = executionFor(task);
      scope.work.worktree = repo;
      scope.work.checkReturns = 2;
      task.plan = { stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }], rationale: "Check recording", plannerProfileId: "opus-high" };
      task.stageIndex = 0;
      const checks = ["Tests", "Build"].map(name => ({ name, argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`Original ${name} diagnostic`)});process.exit(${kind === "passed" ? 0 : 7})`] }));
      engine.s.products[0]!.checks = checks;
      engine.setPoolPaused(false);
      return { engine, task, scope, checks };
    }), () => owners.close());
    const runs: CheckRun[] = [];
    const original = nativeChecks.runChecks;
    const capture = spyOn(nativeChecks, "runChecks"); restore = () => capture.mockRestore();
    capture.mockImplementation(async (...args) => {
      const produced = await original(...args);
      if (args[0] === scope.work.worktree && args[1].every(check => checks.some(expected => expected.name === check.name && JSON.stringify(expected.argv) === JSON.stringify(check.argv))))
        runs.push(...structuredClone(produced));
      return produced;
    });
    let completedReads = 0;
    records = async () => {
      const index = completedReads++;
      if (kind !== "interrupted" && !(kind === "mixed" && index === 1)) return "";
      const startedAt = task.journey!.at(-1)!.productChecks!.find(check => check.result === "running")!.startedAt!;
      const now = Date.now();
      return powerLogSleep(startedAt - 1000, Math.ceil((now - startedAt + 2000) / 1000));
    };
    await owners.run(engine, () => engine["checks"]["runPreparedChecks"](scope, checks, engine.stopRequested.signal));
    restore(); restore = undefined;
    records = noMachineRecords;
    reads.length = 0;
    const at = Date.now();
    const step = task.journey!.at(-1)!;
    const expected = kind === "mixed" ? "Checks: 1 still failing, 1 unverified" : kind === "interrupted" ? "Interrupted — verification incomplete" : kind === "failed" ? "2 of 2 checks failed" : "All 2 checks pass";
    expect(step.outcome).toBe(expected);
    expect(task.timeline.at(-1)!.text).toContain(kind === "mixed" || kind === "interrupted" ? expected : kind === "failed" ? "2 of 2 failed (Tests, Build)" : "Checks passed");
    expect(task.findings.filter((finding) => finding.status === "open")).toHaveLength(kind === "mixed" ? 1 : kind === "failed" ? 2 : 0);
    expect(scope.work.checks!.results).toEqual(runs);
    expect(step.productChecks!.map((check) => check.result)).toEqual(runs.map(checkResult));
    const decision = kind !== "passed" ? engine["checks"]["checkProblem"](task) : undefined;
    const label = checkDecisionLabel(engine.getState().tasks.find((entry) => entry.id === task.id)!);
    // Reuse and startup recovery each read one snapshot for all eligible saved failures.
    expect((await owners.run(engine, () => engine["checks"].failing(scope, engine.stopRequested.signal, checks))).kind).toBe(kind === "passed" ? "passed" : kind === "failed" || kind === "mixed" ? "product-failed" : "blocked");
    expect(reads).toHaveLength(kind === "failed" || kind === "mixed" ? 1 : 0);
    reads.length = 0;
    await owners.run(engine, () => engine["checks"].restoreEvidence());
    expect(reads).toHaveLength(kind === "failed" || kind === "mixed" ? 1 : 0);
    if (kind === "failed") {
      const stop = new AbortController();
      const held = heldMachineRecords();
      records = held.source;
      let pending: Promise<CheckVerification> | undefined, observed: Promise<unknown> | undefined;
      const reuseCount = task.journey!.filter((entry) => entry.work === "check-reuse").length;
      try {
        observed = owners.run(engine, async () => {
          pending = engine["checks"].failing(scope, stop.signal, checks);
          const error = await rejectionOf(pending);
          if (!(error instanceof Aborted)) throw error;
          return error;
        });
        await waitFor(() => held.reads.length === 1, "the owned saved failure's machine-evidence read", undefined, { during: pending });
        expect(held.reads[0]).toBe(stop.signal);
        stop.abort();
        expect(await rejectionOf(pending!)).toBeInstanceOf(Aborted);
        expect(task.journey!.filter((entry) => entry.work === "check-reuse")).toHaveLength(reuseCount);
        expect(scope.work.checkReturns).toBe(2);
      } finally {
        stop.abort(); held.answer(""); await observed;
      }
    }
    if (kind === "mixed") {
      expect(label).toBe("Your call: checks still failing");
      expect(decision!.title).toContain("a check still fails (Tests); unverified (Build)");
      expect(decision!.body).toContain("1 check also unverified");
      expect(decision!.body).toContain("• Tests failed: Original Tests diagnostic");
      expect(decision!.body).toContain("• Build interrupted — verification incomplete");
      expect(decision!.line).toContain("(Tests); unverified (Build)");
      const finding = task.findings[0]!;
      finding.answer = { fixed: true, text: "Added the startup guard.", at };
      expect(engine["checks"]["checkProblem"](task).body).not.toContain("Builder’s explanation — not independently confirmed");
      finding.answer = { fixed: false, text: "I suspect the machine slept.", at };
      expect(engine["checks"]["checkProblem"](task).body).toContain("Builder’s explanation — not independently confirmed");
    } else if (kind === "interrupted") {
      expect(label).toBe("Your call: checks unverified");
      expect(decision!.title).not.toContain("still fails");
      expect(decision!.body).toContain("Approving does not ship while checks fail or remain unverified.");
      expect(decision!.body).not.toContain("while a check fails");
    } else if (kind === "failed") {
      expect(decision!.title).toContain("checks still fail (Tests, Build)");
    } else expect(label).toBeUndefined();
    const state = engine.getState();
    const view = journeyView(state.tasks.find((entry) => entry.id === task.id)!, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: [] });
    expect(view.nodes.find((node) => node.id === step.id)!.outcome).toBe(expected);
    if (kind !== "passed") expect(scope.work.checkReturns).toBe(2);
  } finally { try { restore?.(); } finally { await owners.close(); } }
});
