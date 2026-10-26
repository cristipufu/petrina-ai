import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSetupOutcome, sameCheckEnvironmentIdentity, decisionEvidence, journeyProblems, type Task, type WorkflowEvent } from "@petrina/core";

import { checkWorkflowFixtures } from "../../fixtures/check-workflow.js";
import { coordinator, git, itemOf, taskOf, until, waitFor } from "../../support.js";

const workflows = checkWorkflowFixtures();
afterAll(() => workflows.close());
const fixture = workflows.use;

const lines = (task: Task) => task.timeline.map((entry) => entry.text);
const checkSteps = (task: Task) => task.journey!.filter((step) => step.kind === "petrina" && step.work === "checks");

const reviewStage = (task: Task) => task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");


describe.concurrent("failed checks are evidence until something changes", () => {
it("keeps an early static failure current across returns and restart, with heavy checks visibly skipped", async () => {
    await fixture(async f => {
      try {
        f.engine.setProductChecks(f.productId, [{ name: "Tests", command: f.command("--pass") }, { name: "Type check", command: f.command() }]);
        const task = await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        const step = checkSteps(task)[0]!;
        expect(step.productChecks!.map((check) => [check.name, check.result])).toEqual([["Tests", "skipped"], ["Type check", "fail"]]);
        expect(f.agents.openings("code reviewer")).toEqual([]);
        await f.restart();
        expect((await f.engine["checks"].current(executionFor(f.engine.task(f.taskId)!))).inputs.kind).toBe("matches");
        expect(f.runs()).toEqual(["failed"]);
        f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        const rerun = await f.delivery();
        const evidence = decisionEvidence(rerun);
        expect(f.runs()).toEqual(["failed", "failed"]);
        expect(evidence.map(check => [check.name, check.result, check.reusedAt])).toEqual([["Type check", "fail", undefined], ["Tests", "skipped", undefined]]);
        expect(evidence[1]!.source?.stepId).toBe(checkSteps(rerun).at(-1)!.id);
        expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).not.toContain("no new execution");
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "short", builder: "plain" });
  });

it("finishes the current reviewer but starts no delivery preparation while the pool is paused", async () => {
    await fixture(async f => {
      const release = f.agents.release;
      try {
        f.setCheck("--pass");
        await waitFor(() => {
          for (const prompt of f.agents.received()) if (prompt.role !== "code reviewer") release(prompt.session);
          coordinator(["plan"])(f.engine, f.engine.getState());
          return f.agents.received("code reviewer").length > 0;
        }, "the final reviewer to start");
        expect(f.runs()).toEqual(["passed"]);
        f.engine.setPoolPaused(true);
        f.setCheck("--pass", "--new-definition");
        for (const prompt of f.agents.received("code reviewer")) release(prompt.session);
        const waiting = await until(f.engine, (state) => taskOf(state, f.taskId).state === "waiting");
        expect(taskOf(waiting, f.taskId).statusLine).toBe("Waiting for the pool to resume");
        expect(taskOf(waiting, f.taskId).holdsSlot).toBe(false);
        expect(f.runs()).toEqual(["passed"]);
        expect(itemOf(waiting, f.taskId, "delivery")).toBeUndefined();
        f.engine.setPoolPaused(false);
        await f.delivery();
        expect(f.runs()).toEqual(["passed", "passed"]);
        expect(f.agents.openings("code reviewer")).toHaveLength(1);
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "short", builder: "plain", controlled: true });
  });

it("reuses one passing run through read-only reviewers, acceptance and delivery without dropping an acceptance pass", async () => {
    await fixture(async f => {
      try {
        f.setCheck("--pass");
        const task = await f.delivery();
        expect(f.runs()).toEqual(["passed"]);
        expect(f.agents.openings("tester")).toHaveLength(1);
        expect(f.agents.openings("tester")[0]).toContain("Recorded product checks, run by Petrina itself");
        expect(f.agents.openings("tester")[0]).toContain("Use focused tests for acceptance rather than repeating full suites");
        expect(f.agents.openings("code reviewer").length).toBeGreaterThan(0);
        expect(f.agents.openings("code reviewer").every((prompt) => prompt.includes("Recorded product checks, run by Petrina itself"))).toBe(true);
        expect(checkSteps(task)).toHaveLength(1);
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        expect(f.runs()).toEqual(["passed"]);
        expect(f.agents.openings("tester")).toHaveLength(1);
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "tester-first", builder: "plain" });
  });

it("spends no acceptance turn on unchanged failing code before asking the coordinator", async () => {
    await fixture(async f => {
      try {
        const task = await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        expect(f.agents.openings("tester")).toHaveLength(0);
        expect(f.agents.openings("code reviewer")).toHaveLength(0);
        expect(task.journey?.some((step) => step.roleId === "tester")).toBe(false);
        expect(journeyProblems(task as Task)).toEqual([]);
        expect(task.checkReturns).toBe(2);
        expect(task.findings.some((finding) => finding.text.startsWith("Check failed") && finding.status === "open")).toBe(true);
        // Acceptance testing waits where the checks stopped it, and starts once they pass.
        expect(task.plan!.stages[task.stageIndex]!.roleId).toBe("tester");
        expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("Stopped before acceptance testing.");
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "tester-first", builder: "plain" });
  });

it("asks the coordinator before final acceptance when later checks fail after their builder returns are exhausted", async () => {
    await fixture(async f => {
      try {
        f.setCheck("--pass");
        const original = await f.delivery();
        const testedPatch = original.testedPatch;
        const reviewers = f.agents.openings("code reviewer").length;
        expect(f.agents.openings("tester")).toHaveLength(1);
        expect(original.acceptancePassed).toBe(true);

        // A later fix changes the patch after acceptance has already passed. The earlier
        // automatic check fixes have used their allowance, as on a long-running task.
        const live = f.engine.task(f.taskId)!;
        writeFileSync(join(executionFor(live).work.worktree!, "later-fix.txt"), "A later change\n");
        await f.run(() => git(executionFor(live).work.worktree!, "add", "later-fix.txt"));
        await f.run(() => git(executionFor(live).work.worktree!, "commit", "-q", "-m", "A later change"));
        // Change the live record only once the commit has finished, right before the engine acts on it.
        executionFor(live).work.checkReturns = 2;
        f.setCheck();
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the later change");

        const failed = await f.delivery();
        expect(failed.checks!.results.some((run) => !run.ok)).toBe(true);
        expect(failed.checkReturns).toBe(2);
        expect(failed.testedPatch).toBe(testedPatch);
        expect(f.agents.openings("tester")).toHaveLength(1);
        expect(f.agents.openings("code reviewer")).toHaveLength(reviewers);
        expect(failed.statusLine).toBe("Checks still fail. Your call");
        expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("Automated checks: 1 of 1 failed (Welcome)");
        expect(journeyProblems(failed)).toEqual([]);

        await f.restart();
        expect(f.agents.openings("tester")).toHaveLength(1);
        expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(failed.checks);

        // A coordinator-authorized real fix still goes through checks, review and
        // final acceptance. Escalating must not mark the unfinished review complete.
        f.agents.scenario({ planner: "tester-first", builder: "plain", fixes: "change" });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed welcome check");
        const fixed = await f.delivery();
        expect(fixed.checks!.results.every((run) => run.ok)).toBe(true);
        expect(f.agents.openings("code reviewer")).toHaveLength(reviewers * 2);
        expect(f.agents.openings("tester")).toHaveLength(2);
        expect(fixed.testedPatch).not.toBe(testedPatch);
        expect(journeyProblems(fixed)).toEqual([]);
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "tester-first", builder: "plain" });
  });

it("returns unchanged work twice without using a review round, keeps the failure after restart, and checks a real fix", async () => {
    await fixture(async f => {
      try {
        let task = await f.delivery();
        const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
        const captured = task.checks;
        expect(f.runs()).toEqual(["failed"]);
        expect(task.checkReturns).toBe(2);
        expect(task.rounds[review.id] ?? 1).toBe(1);
        expect(task.blockingAfter?.[review.id]).toBeUndefined();
        expect(task.reviewedSha).toBeUndefined();
        expect(f.agents.openings("builder")).toHaveLength(3);
        expect(f.agents.openings("code reviewer")).toHaveLength(0);
        expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(false);
        expect(lines(task)).not.toContain("Reviewers wait until the checks pass");
        expect(task.statusLine).toBe("Checks still fail. Your call");
        const recordedChecks = checkSteps(task);
        expect(recordedChecks).toHaveLength(1);
        expect(recordedChecks[0]).toEqual(expect.objectContaining({ outcome: "1 of 1 check failed", reason: "1 check failed", tone: "back", end: "done", endedAt: expect.any(Number) }));
        expect(task.journey!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(0);
        expect(task.timeline.find((entry) => entry.text.startsWith("Checks:"))?.step).toBe(recordedChecks[0]!.id);
        expect(journeyProblems(task)).toEqual([]);
        const failure = task.findings.find((finding) => finding.text.startsWith("Check failed"))!;
        // The fake builder claims it fixed the finding without changing any files. Evidence wins.
        expect(failure.answer?.fixed).toBe(true);
        expect(failure.status).toBe("open");
        const repairs = task.journey!.filter((step) => step.fixing && step.roleId === "builder");
        expect(repairs.every((step) => step.builderReturn?.changed === false)).toBe(true);
        expect(repairs.every((step) => step.outcome?.startsWith("No code changes; checks still failing"))).toBe(true);
        expect(task.journey!.filter((step) => step.work === "check-reuse").every((step) => step.productChecks?.[0]?.run?.source?.stepId === recordedChecks[0]!.id)).toBe(true);
        expect(task.journey!.at(-1)!.productChecks?.[0]?.reusedAt).toBeNumber();
        expect(failure.evidence).toContain("captured failure");
        expect(f.agents.prompts("builder").filter((text) => text.includes("captured failure"))).toHaveLength(2);
        // Rereading the saved failure keeps its diagnostics: the saved log, the journey's run and the check problem.
        const run = task.checks!.results[0]!;
        expect(readFileSync(run.logPath!, "utf8")).toContain("captured failure");
        expect(recordedChecks[0]!.productChecks![0]!.run?.logPath).toBe(run.logPath);
        expect(task.stageIndex).toBe(reviewStage(task));
        const blocker = itemOf(f.engine.getState(), f.taskId, "delivery")!;
        expect(blocker.title).toBe("Your call on “Add a greeting”: a check still fails (Welcome)");
        expect(blocker.body).toContain("• Welcome failed: The welcome page is missing (captured failure)");
        expect(blocker.body).toContain("Stopped before the review.");

        // Each automatic return is a check repair: the first from the run, the second from the handoff of its unchanged failure.
        const reuses = task.journey!.filter((step) => step.work === "check-reuse");
        const returnedEvents = (await f.engine.events.wait({ taskIds: [f.taskId], from: "oldest", timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
        expect(returnedEvents.filter((event) => event.kind === "repair.returned").map(({ repairKind, cause, allowance }) => ({ repairKind, cause, allowance }))).toEqual([
          { repairKind: "checks", cause: { nodeId: recordedChecks[0]!.id, kind: "checks", reason: "1 check failed" }, allowance: { checkReturns: 1, acceptanceReturns: 0, limit: 2 } },
          { repairKind: "checks", cause: { nodeId: reuses[0]!.id, kind: "check-reuse", reason: reuses[0]!.reason }, allowance: { checkReturns: 2, acceptanceReturns: 0, limit: 2 } },
        ]);

        await f.restart();
        expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(captured);
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the welcome page");
        task = await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        expect(task.checks).toEqual(captured);
        expect(task.checkReturns).toBe(2);
        expect(task.findings.filter((finding) => finding.text.startsWith("Check failed"))).toHaveLength(1);
        // The guarded review reuses the failure: no review or acceptance starts, and the allowance stays spent.
        expect(checkSteps(task).map(({ reuses: _reuses, checkSetups: _setups, ...step }) => step)).toEqual(recordedChecks.map(({ reuses: _reuses, checkSetups: _setups, ...step }) => step));
        const originalSetups = recordedChecks[0]!.checkSetups!, reusedSetups = checkSteps(task)[0]!.checkSetups!;
        expect(reusedSetups.slice(0, originalSetups.length)).toEqual([...originalSetups]);
        const additionalSetups = reusedSetups.slice(originalSetups.length);
        expect(additionalSetups).toHaveLength(1);
        const observation = additionalSetups[0]!;
        expect(observation.id).not.toBe(originalSetups.at(-1)!.id);
        expect(observation.queuedAt).toBeGreaterThanOrEqual(originalSetups.at(-1)!.endedAt!);
        expect(observation.position).toBe("before-checks");
        expect(checkSetupOutcome(observation).kind).toBe("verified");
        expect(sameCheckEnvironmentIdentity(observation.identity, captured!.environment)).toBe(true);
        expect(checkSteps(task)[0]!.reuses!.at(-1)!.environment!.setupAttemptId).toBe(observation.id);
        const retainedSetups = structuredClone(reusedSetups);
        expect(checkSteps(task)[0]!.reuses!.map((entry) => entry.purpose)).toEqual(["review", "review", "review"]);
        expect(checkSteps(task)[0]!.reuses!.every((entry) => !entry.passed && entry.tree === captured!.tree)).toBe(true);
        expect(checkSteps(task)[0]!.checkAttempts![0]).toMatchObject({ sha: captured!.sha, tree: captured!.tree, definition: captured!.definition });
        expect(checkSteps(task)[0]!.checkAttempts![0]!.passed).toBeUndefined();
        const blockedEvents = (await f.engine.events.wait({ taskIds: [f.taskId], from: "oldest", timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
        expect(blockedEvents.find((event) => event.kind === "check.reused")).toMatchObject({ nodeId: captured!.provenance!.nodeId, purpose: "review", passed: false, tree: captured!.tree, definition: captured!.definition });
        // The coordinator's request gave the Builder its turn; the unchanged failure then came back to them, with no further return.
        const returns = blockedEvents.filter((event) => event.kind === "repair.returned");
        expect(returns.at(-1)).toMatchObject({ repairKind: "changes", cause: { kind: "delivery" }, allowance: { checkReturns: 2, acceptanceReturns: 0, limit: 2 } });
        expect(returns.some((event) => event.repairKind === "review")).toBe(false);
        expect(blockedEvents.some((event) => event.kind === "seat.started" && ["code-reviewer", "tester"].includes(String(event.roleId)))).toBe(false);
        expect(blockedEvents.find((event) => event.kind === "coordinator.request" && event.requestKind === "delivery")).toMatchObject({ title: blocker.title });
        expect(journeyProblems(task)).toEqual([]);

        f.agents.scenario({ planner: "short", fixes: "change" });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Make the actual fix");
        task = await f.delivery();
        expect(f.runs()).toEqual(["failed", "passed"]);
        expect(task.checks!.tree).not.toBe(captured!.tree);
        expect(task.checks!.results.every((run) => run.ok)).toBe(true);
        expect(task.checkReturns).toBeUndefined();
        expect(task.findings.find((finding) => finding.id === failure.id)?.status).toBe("fixed");
        expect(task.rounds[review.id] ?? 1).toBe(1);
        expect(task.blockingAfter?.[review.id]).toEqual([0]);
        expect(f.agents.openings("code reviewer")).toHaveLength(1);
        expect(checkSteps(task)).toHaveLength(2);
        expect((({ reuses: _reuses, checkSetups: _setups, ...step }) => step)(checkSteps(task)[0]!)).toEqual((({ reuses: _reuses, checkSetups: _setups, ...step }) => step)(recordedChecks[0]!));
        expect(checkSteps(task)[0]!.checkSetups).toEqual(retainedSetups);
        expect(checkSteps(task)[1]).toEqual(expect.objectContaining({ outcome: "The check passes", reason: "checks passed", end: "done" }));
        const recoveredEvents = (await f.engine.events.wait({ taskIds: [f.taskId], from: "oldest", timeoutMs: 0, limit: 100 })).events as WorkflowEvent[];
        expect(recoveredEvents.find((event) => event.kind === "node.started" && event.roleId === "code-reviewer")).toMatchObject({ checks: { basis: "ran", passed: true, nodeId: checkSteps(task)[1]!.id } });
        expect(task.journey!.find((step) => step.roleId === "code-reviewer")).toEqual(expect.objectContaining({ outcome: "1 nit", reason: "review passed", end: "done" }));
        expect(journeyProblems(task)).toEqual([]);
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        expect(f.runs()).toEqual(["failed", "passed"]);
      } finally {
        await f.engine.shutdown();
      }
    });
  });

it("does not consume more rounds when reviews were already exhausted, including a saved run from before the update", async () => {
    await fixture(async f => {
      try {
        // Start with passing checks and a real review that uses up its sole round.
        f.setCheck("--pass");
        f.agents.scenario({ planner: "short", reviewer: "important" });
        let task = await f.delivery();
        const review = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
        expect(task.blockingAfter?.[review.id]).toEqual([1]);
        expect(lines(task).filter((line) => line.startsWith("Review rounds used up"))).toHaveLength(1);
        f.setCheck();
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix what failed");
        task = await f.delivery();
        expect(f.runs()).toEqual(["passed", "failed"]);
        const captured = task.checks!;

        // Resume at review as a restart between saving the failure and handling its return would do.
        // Older saved results have the commands and tree, but no definition fingerprint.
        await f.restart((state) => {
          const saved = state.tasks.find((task) => task.id === f.taskId)!;
          delete saved.checks!.definition;
          saved.stageIndex = saved.plan!.stages.findIndex((stage) => stage.id === review.id);
          saved.state = "waiting";
          state.inbox = state.inbox.filter((item) => item.taskId !== f.taskId);
        });
        task = await f.delivery();
        expect(f.runs()).toEqual(["passed", "failed"]);
        expect(task.checks!.at).toBe(captured.at);
        expect(task.checks!.definition).toBeUndefined();
        expect(task.checks!.results).toEqual(captured.results);
        expect(task.blockingAfter?.[review.id]).toEqual([1]);
        expect(task.rounds[review.id] ?? 1).toBe(1);
        expect(lines(task).filter((line) => line.startsWith("Review rounds used up"))).toHaveLength(1);
        expect(f.agents.openings("code reviewer")).toHaveLength(1);

        f.agents.scenario({ planner: "short", fixes: "change" });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the welcome page");
        task = await f.delivery();
        expect(f.runs()).toEqual(["passed", "failed", "passed"]);
        expect(task.blockingAfter?.[review.id]).toEqual([1, 0]);
      } finally {
        await f.engine.shutdown();
      }
    }, true, { planner: "short" }, "Exhausted review rounds");
  });

it("runs changed commands on the same code, including at final delivery preparation", async () => {
    await fixture(async f => {
      try {
        let task = await f.delivery();
        const failedTree = task.checks!.tree;
        f.setCheck("--pass");
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Use the corrected check");
        task = await f.delivery();
        expect(task.checks!.tree).toBe(failedTree);
        expect(f.runs()).toEqual(["failed", "passed"]);

        // The coordinator changes the required command after review: final preparation must notice it.
        f.setCheck("--pass", "--changed");
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        expect(f.runs()).toEqual(["failed", "passed", "passed"]);
      } finally {
        await f.engine.shutdown();
      }
    });
  });

it("keeps a forced check decision and allows explicit reruns without approving delivery or replenishing repairs", async () => {
    await fixture(async f => {
      try {
        const blocked = await f.delivery();
        expect(f.runs()).toEqual(["failed"]);
        expect(blocked.stageIndex).toBe(reviewStage(blocked));
        // This task normally delivers without asking. Failed checks still bring it to the coordinator.
        const decision = itemOf(f.engine.getState(), f.taskId, "delivery")!.id;
        expect(() => f.engine.approve(decision)).toThrow("delivery has not been approved");
        expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.id).toBe(decision);
        expect(f.runs()).toEqual(["failed"]);

        f.engine.rerunChecks(decision);
        const failed = await f.delivery();
        expect(f.runs()).toEqual(["failed", "failed"]);
        expect(failed.checks!.results[0]!.output).toContain("captured failure");
        expect(failed.checkReturns).toBe(2);
        expect(failed.approvedSha).toBeUndefined();
        expect(failed.error).toBeUndefined();

        f.setCheck("--pass");
        f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        expect(f.runs()).toEqual(["failed", "failed", "passed"]);
        // The passing run continued at the review the checks had held back; nothing shipped unreviewed.
        expect(f.agents.openings("code reviewer")).toHaveLength(1);
      } finally {
        await f.engine.shutdown();
      }
    }, false);
  });

it("keeps completed evidence when a changed check is cancelled, then runs the required check after restart", async () => {
    await fixture(async f => {
      try {
        const captured = (await f.delivery()).checks;
        f.setCheck("--hold");
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the updated command");
        await until(f.engine, () => f.runs().includes("started"), coordinator(["plan"]));
        f.engine.pause(f.taskId);
        expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(captured);
        await f.restart();
        expect(taskOf(f.engine.getState(), f.taskId).state).toBe("paused");
        f.setCheck("--pass");
        f.engine.resume(f.taskId);
        const task = await f.delivery();
        expect(f.runs()).toEqual(["failed", "started", "passed"]);
        expect(task.checks!.results.every((run) => run.ok)).toBe(true);
        expect(task.blockingAfter?.[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id]).toEqual([0]);
      } finally {
        await f.engine.shutdown();
      }
    });
  });

it("requires a fresh final run when main moves after approval", async () => {
    await fixture(async f => {
      try {
        f.setCheck("--pass");
        const reviewedTree = (await f.delivery()).checks!.tree;
        writeFileSync(join(f.repo, "NEWS.md"), "News from another task\n");
        await f.run(() => git(f.repo, "add", "NEWS.md"));
        await f.run(() => git(f.repo, "commit", "-q", "-m", "News on main"));
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        const shipped = taskOf(state, f.taskId);
        expect(f.runs()).toEqual(["passed", "passed"]);
        expect(shipped.checks!.tree).not.toBe(reviewedTree);
        expect(shipped.checks!.sha).toBe(await f.run(() => git(f.repo, "rev-parse", "main")));
      } finally {
        await f.engine.shutdown();
      }
    });
  });

for (const exhausted of [false, true]) {
    it(`reviews a real fix normally after port checks fail with builder returns ${exhausted ? "used up" : "available"}`, async () => {
      await fixture(async f => {
        try {
          f.setCheck("--pass");
          await f.delivery();
          expect(f.agents.openings("code reviewer")).toHaveLength(2);
          if (exhausted) await f.restart((state) => { state.tasks.find((task) => task.id === f.taskId)!.checkReturns = 2; });
          // Main overlaps the already reviewed work. The builder must port greeting.txt by hand.
          writeFileSync(join(f.repo, "greeting.txt"), "A greeting on main\n");
          await f.run(() => git(f.repo, "add", "greeting.txt"));
          await f.run(() => git(f.repo, "commit", "-q", "-m", "A greeting on main"));
          f.setCheck();
          // The port resolves greeting.txt; the later check fix changes welcome.txt, outside the port.
          f.agents.scenario({ fixes: "change" });
          f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          if (exhausted) {
            const failed = await f.delivery();
            expect(f.runs()).toEqual(["passed", "failed"]);
            expect(failed.portReview).toBeUndefined();
            expect(f.agents.openings("code reviewer")).toHaveLength(2);
            f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed welcome check");
          }
          const task = await f.delivery();
          expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
          expect(f.runs()).toEqual(["passed", "failed", "passed"]);
          expect(existsSync(join(task.worktree!, "welcome.txt"))).toBe(true);
          const reviews = f.agents.openings("code reviewer").slice(2);
          expect(reviews).toHaveLength(2);
          for (const prompt of reviews) {
            expect(prompt).not.toContain("Review only the port");
            expect(prompt).toContain(`git diff ${task.baseSha}...HEAD`);
          }
          expect(task.portReview).toBeUndefined();
          expect(task.rounds[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id] ?? 1).toBe(1);
        } finally {
          await f.engine.shutdown();
        }
      }, true, {});
    });
  }
});
