import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";


import { journeyProblems, journeyView, type State, type Task } from "@petrina/core";
import type { Engine } from "../../engine.js";
import type { CheckScript } from "../../fixtures/check-agents.js";
import { checkWorkflow } from "../../fixtures/check-workflow.js";
import { coordinator, itemOf, removeDir, tempDir, taskOf, until, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[] } | string) {
  const root = tempDir("petrina-check-failure-"); roots.push(root);
  return checkWorkflow(root, approveDelivery, scenario, extra);
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);
const checkSteps = (task: Task) => task.journey!.filter((step) => step.kind === "petrina" && step.work === "checks");
const sentBack = (task: Task) => lines(task).filter((line) => line.startsWith("Sent back to the builder: the checks failed")).length;
const reviewStage = (task: Task) => task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
const ahead = (engine: Engine, task: Task) => {
  const state = engine.getState();
  return journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter((node) => node.state === "next" || node.state === "ahead").map((node) => node.name);
};


describe.concurrent("automatic check repairs belong to one failure episode", () => {
it("gives a later failure its own two repairs after a genuine pass, and reviews and retests a fix made after review passed", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain", fixes: "change" }, { checkArgs: ["--sequence=FFP"] });
    try {
      let task = await f.delivery();
      // Two automatic turns, then a real pass on the changed code closes the episode before acceptance testing.
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
      expect(sentBack(task)).toBe(2);
      expect(task.checkReturns).toBeUndefined();
      expect(f.agents.openings("builder")).toHaveLength(3);
      expect(f.agents.openings("tester")).toHaveLength(1);
      expect(f.agents.openings("code reviewer")).toHaveLength(2);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");

      // A changed check fails on what was about to ship: the new episode has its own two returns again.
      f.setCheck("--sequence=FFPFFP", "--later");
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      task = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed", "passed", "failed", "failed", "passed"]);
      expect(sentBack(task)).toBe(4);
      expect(task.checkReturns).toBeUndefined();
      expect(f.agents.openings("builder")).toHaveLength(5);
      // The fix made after review passed is reviewed again and tried once more before the delivery check; nothing shipped.
      expect(f.agents.openings("code reviewer")).toHaveLength(4);
      expect(f.agents.openings("tester")).toHaveLength(2);
      expect(task.state).toBe("needs-you");
      expect(task.approvedSha).toBeUndefined();
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");
      expect(journeyProblems(task)).toEqual([]);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toHaveLength(6);
    } finally { await f.engine.shutdown(); }
  });

it("keeps a pending review round when check repairs run out, and runs it with its number after a passing fix", async () => {
    const f = await fixture(true, { planner: "tester-first", builder: "plain", reviewer: "important", fixes: "change" }, { checkArgs: ["--sequence=PFFFP"] });
    try {
      let task = await f.delivery();
      const review = reviewStage(task);
      const stage = task.plan!.stages[review]!;
      // Round 1 sent a finding back; its fix fails the checks three times in a row before round 2.
      expect(f.runs()).toEqual(["passed", "failed", "failed", "failed"]);
      expect(task.stageIndex).toBe(review);
      expect(task.rounds[stage.id]).toBe(2);
      expect(task.blockingAfter?.[stage.id]).toEqual([1]);
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.agents.openings("code reviewer")).toHaveLength(2);
      expect(f.agents.openings("tester")).toHaveLength(1);
      const anchor = task.reviewedSha;
      expect(anchor).toBeDefined();
      const item = itemOf(f.engine.getState(), f.taskId, "delivery")!;
      expect(item.title).toBe("Your call on “Add a greeting”: a check still fails (Welcome)");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(item.body).toContain("Still failing after 2 automatic Builder turns.\n• Welcome failed: The welcome page is missing (captured failure)");
      expect(item.body).toContain("The Builder's last answer, saying it fixed this: “Fixed it.”");
      // The Builder answered round 1's Important finding and its nit; no reviewer has looked at either fix yet.
      expect(item.body).toContain("Stopped before the review (round 2). A reviewer has not yet confirmed 2 fixes the Builder made for review findings.");
      expect(item.body).toMatch(/After the Builder's next turn, still to come: code review again \([^)]*\), then final acceptance testing \([^)]*\) if the code changed, then your OK to ship/);
      expect(item.body).toContain("Send back with a note to give the Builder one more turn. Approving does not ship while checks fail or remain unverified.");
      expect(item.body).toContain("Automated checks: 1 of 1 failed (Welcome).");
      expect(lines(task)).toContain("Checks still fail after 2 automatic Builder turns (Welcome), so Petrina waits for you before the review (round 2)");
      // The journey still shows the pending review round ahead of the delivery check.
      const upcoming = ahead(f.engine, task);
      expect(upcoming.indexOf("Code reviewers (round 2)")).toBeGreaterThanOrEqual(0);
      expect(upcoming.indexOf("Code reviewers (round 2)")).toBeLessThan(upcoming.indexOf("Your delivery check"));
      expect(journeyProblems(task)).toEqual([]);

      f.engine.requestChanges(item.id, "Fix the welcome check");
      task = await f.delivery();
      expect(f.runs()).toEqual(["passed", "failed", "failed", "failed", "passed"]);
      expect(task.checkReturns).toBeUndefined();
      // Round 2 ran on the changes since round 1, kept its number, then acceptance was tried on the final code.
      const second = f.agents.openings("code reviewer").slice(2);
      expect(second).toHaveLength(2);
      for (const prompt of second) {
        expect(prompt).toContain("This is review round 2:");
        expect(prompt).toContain(`Incremental comparison git diff ${anchor}..HEAD:`);
      }
      expect(task.rounds[stage.id]).toBe(2);
      expect(task.blockingAfter?.[stage.id]).toEqual([1, 0]);
      expect(f.agents.openings("tester")).toHaveLength(2);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.title).toBe("Ready to ship “Add a greeting”");
      expect(journeyProblems(task)).toEqual([]);
    } finally { await f.engine.shutdown(); }
  });

it("keeps the episode count across a restart, the blocker and its position after one, and the cleared count after a pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain", controlled: true });
    const release = f.agents.release;
    const releaseAll = (engine: Engine, state: State) => {
      coordinator(["plan"])(engine, state);
      for (const prompt of f.agents.received()) release(prompt.session);
    };
    try {
      // Hold the first automatic repair while it works, then restart in the middle of the episode.
      await waitFor(() => {
        coordinator(["plan"])(f.engine, f.engine.getState());
        const builders = f.agents.received("builder");
        for (const prompt of f.agents.received()) if (prompt.role !== "builder" || prompt.session === builders[0]?.session) release(prompt.session);
        return builders.length >= 2;
      }, "the first automatic repair to start");
      expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
      await f.restart();
      expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
      let state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
      let task = taskOf(state, f.taskId);
      // One more automatic turn after the restart, never a fresh pair.
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.runs()).toEqual(["failed"]);
      const item = itemOf(state, f.taskId, "delivery")!;

      await f.restart();
      state = f.engine.getState();
      task = taskOf(state, f.taskId);
      expect(itemOf(state, f.taskId, "delivery")).toEqual(item);
      expect(task.stageIndex).toBe(reviewStage(task));
      expect(task.state).toBe("needs-you");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(task.checkReturns).toBe(2);

      // The coordinator's turn is not a fresh allowance: a still-failing run returns straight to the blocker.
      const builders = f.agents.openings("builder").length;
      f.engine.requestChanges(item.id, "Try once more");
      state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
      task = taskOf(state, f.taskId);
      expect(f.agents.openings("builder").length).toBe(builders + 1);
      expect(task.checkReturns).toBe(2);
      expect(sentBack(task)).toBe(2);
      expect(f.agents.openings("code reviewer")).toHaveLength(0);

      f.agents.scenario({ planner: "short", builder: "plain", controlled: true, fixes: "change" });
      f.engine.requestChanges(itemOf(state, f.taskId, "delivery")!.id, "Make the actual fix");
      state = await until(f.engine, (state) => itemOf(state, f.taskId, "delivery")?.title.startsWith("Ready to ship") ?? false, releaseAll);
      expect(f.runs()).toEqual(["failed", "passed"]);
      expect(taskOf(state, f.taskId).checkReturns).toBeUndefined();
      await f.restart();
      expect(taskOf(f.engine.getState(), f.taskId).checkReturns).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

it("restores a saved task's spent allowance at its next verified pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain" }, { checkArgs: ["--pass"] });
    try {
      await f.delivery();
      // Saved before episodes existed: both returns spent, although the checks pass now.
      await f.restart((state) => { state.tasks.find((task) => task.id === f.taskId)!.checkReturns = 2; });
      expect(taskOf(f.engine.getState(), f.taskId).checkReturns).toBe(2);
      f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
      expect(f.runs()).toEqual(["passed"]);
      expect(taskOf(state, f.taskId).checkReturns).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

it("keeps a check open when the Builder blames the environment, and shows that answer as its claim", async () => {
    const claim = "Nothing to fix: the check failed because the Mac went to sleep.";
    const f = await fixture(true, { planner: "short", builder: "plain", answer: { fixed: false, text: claim } });
    try {
      const task = await f.delivery();
      expect(f.runs()).toEqual(["failed"]);
      expect(task.checkReturns).toBe(2);
      const failure = task.findings.find((finding) => finding.text.startsWith("Check failed"))!;
      expect(failure).toEqual(expect.objectContaining({ status: "open", answer: expect.objectContaining({ fixed: false, text: claim }) }));
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain(`The Builder's last answer: “${claim}”`);
      expect(f.agents.openings("code reviewer")).toHaveLength(0);
      expect(task.journey!.filter((step) => step.fixing && step.roleId === "builder").every((step) => step.outcome === "No code changes; checks still failing")).toBe(true);
      expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).toContain("not independently confirmed");
    } finally { await f.engine.shutdown(); }
  });

it("runs unchanged work only on the coordinator's explicit request and resumes review after a pass", async () => {
    const f = await fixture(true, { planner: "short", builder: "plain" }, { checkArgs: ["--sequence=FFP"] });
    try {
      const first = await f.delivery();
      expect(first.checkReturns).toBe(2);
      expect(f.runs()).toEqual(["failed"]);
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const second = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed"]);
      expect(second.checkReturns).toBe(2);
      expect(second.approvedFor).toBeUndefined();
      expect(f.agents.openings("builder")).toHaveLength(3);
      expect(checkSteps(second)).toHaveLength(2);
      f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
      const passing = await f.delivery();
      expect(f.runs()).toEqual(["failed", "failed", "passed"]);
      expect(f.agents.openings("code reviewer")).toHaveLength(1);
      expect(passing.approvedFor).toBeUndefined();
      expect(passing.checkReturns).toBeUndefined();
      expect(checkSteps(passing)).toHaveLength(3);
      expect(passing.journey!.filter((step) => step.work === "checks")[0]).toEqual(checkSteps(first)[0]);
    } finally { await f.engine.shutdown(); }
  });
});
