import { rejectionOf } from "@petrina/test-support/rejections";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { checkDecisionLabel, checkResult, journeyView, type CheckRun } from "@petrina/core";
import { Engine } from "../../engine.js";


import { Aborted } from "../../../src/kernel.js";
import { executionFor } from "@petrina/orchestrator";
import type { MachineRecords } from "../../../src/check-interruption.js";
import { heldMachineRecords, makeProduct, noMachineRecords, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

// Enter at check recording: no agents or unrelated planning/review workflow.

it.each(["failed", "interrupted", "mixed", "passed"] as const)("keeps %s results consistent through recording, decision and reuse", async (kind) => {
  const root = tempDir("petrina-check-outcomes-");
  roots.push(root);
  // This engine's own sleep records: each read is counted, and a step can hold one.
  const reads: (AbortSignal | undefined)[] = [];
  let records: MachineRecords = noMachineRecords;
  const engine = new Engine(join(root, "data"), { usageCommands: { codex: null, grok: null }, agentCommand: () => undefined, terminals: () => [], machineRecords: (signal) => { reads.push(signal); return records(signal); } });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  try {
    const repo = await makeProduct(root);
    engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator" });
    const task = engine.task(engine.addTask({ productId: "product", title: "Check evidence" }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    scope.work.checkReturns = 2;
    task.plan = { stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }], rationale: "Check recording", plannerProfileId: "opus-high" };
    task.stageIndex = 0;
    const checks = [{ name: "Tests", argv: ["test"] }, { name: "Build", argv: ["build"] }];
    engine.s.products[0]!.checks = checks;
    const at = Date.parse("2026-10-21T17:01:00+03:00");
    const runs: CheckRun[] = checks.map((check, index) => ({
      name: check.name, command: check.argv[0]!, ok: kind === "passed", ms: 240_000, output: `Original ${check.name} diagnostic`,
      execution: completeCheckExecution(kind === "passed" ? 0 : 7),
      startedAt: at + (kind === "interrupted" ? 1 : index) * 3_180_000, endedAt: at + (kind === "interrupted" ? 1 : index) * 3_180_000 + 240_000,
      ...((kind === "interrupted" || kind === "mixed" && index === 1) ? { interruption: { source: "macOS power log" as const, at: Date.parse("2026-10-21T17:55:44+03:00"), event: "Entering Sleep state" } } : {}),
    }));
    engine.setPoolPaused(false);
    await engine["checks"]["runPreparedChecks"](scope, checks, new AbortController().signal, runs);
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
    expect(await engine["checks"].failing(scope, new AbortController().signal, checks)).toBe(kind !== "passed");
    expect(reads).toHaveLength(kind === "failed" || kind === "mixed" ? 1 : 0);
    reads.length = 0;
    await engine["checks"].restoreEvidence();
    expect(reads).toHaveLength(kind === "failed" || kind === "mixed" ? 1 : 0);
    if (kind === "failed") {
      const stop = new AbortController();
      const held = heldMachineRecords();
      records = held.source;
      let pending: Promise<boolean> | undefined;
      const reuseCount = task.journey!.filter((entry) => entry.work === "check-reuse").length;
      try {
        pending = engine["checks"].failing(scope, stop.signal, checks);
        await held.started();
        expect(held.reads[0]).toBe(stop.signal);
        stop.abort();
        expect(await rejectionOf(pending)).toBeInstanceOf(Aborted);
        expect(task.journey!.filter((entry) => entry.work === "check-reuse")).toHaveLength(reuseCount);
        expect(scope.work.checkReturns).toBe(2);
      } finally {
        stop.abort(); held.answer(""); await pending?.catch(() => {});
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
  } finally { await engine.shutdown(); }
});
