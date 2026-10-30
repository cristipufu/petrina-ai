import { usageWorlds } from "../../fixtures/usage-world.js";
import { afterAll, describe, expect, it } from "bun:test";


import { journeyProblems, type Task } from "@petrina/core";








const worlds = usageWorlds();
afterAll(() => worlds.close());
const start = worlds.use;

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("usage reports", () => {
  it("keeps the planned Claude agent when repeated live reports reject only paid usage", async () => {
    await start(async run => {
      try {
        const task = await run.completed("builder");
        expect(task.builderSession?.toolId).toBe("claude-code");
        expect(run.fakes.received("builder")).toHaveLength(1);
        expect(run.engine.getState().pool.limited ?? []).toEqual([]);
        expect(run.engine.getState().pool.usage!.some(report => report.kind === "overage")).toBe(false);
        const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
        expect(details.failuresByReason).toEqual([]);
        expect(details.retries).toBe(0);
      } finally { await run.engine.shutdown(); }
    }, { planner: "claude-build", builder: "plain", usage: [{ model: "opus", status: "allowed", utilization: 0.05, type: "five_hour", paidStatus: "rejected" }] }, { entry: "builder" });
  });


  it("move new agents to an equal profile on another tool once a tool is at 90% or warns, without touching the plan", async () => {
    await start(async run => {
      try {
        const task = await run.completed("builder");
        const builders = run.fakes.received("builder");
        expect(builders).toHaveLength(1);
        // The planner (Claude Code) reported the warning; the builder, planned on Claude Code, went to Codex.
        expect(run.modelOf(builders[0]!.session)).toBe("gpt-6.1-sol");
        expect(task.plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
        const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
        expect(details.failuresByReason).toEqual([]);
        expect(details.retries).toBe(0);
        expect(run.engine.getState().pool.limited ?? []).toEqual([]);
        expect(task.journey!.filter((step) => step.roleId === "builder")).toEqual([expect.objectContaining({ profileId: "sol-high" })]);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", usage: [{ model: "opus", status: "allowed_warning", utilization: 0.93 }] });
  });


  it("works the step on Grok when Claude Code and Codex are both out, and leaves the plan as written", async () => {
    const until = Date.now() + 120_000;
    await start(async run => {
      try {
        const task = await run.completed("builder");
        const builders = run.fakes.received("builder");
        expect(builders).toHaveLength(1);
        expect(run.modelOf(builders[0]!.session)).toBe("grok-4.7");
        expect(task.plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
        expect(lines(task).some((line) => line.includes("took over from"))).toBe(false);
        const steps = task.journey!.filter((step) => step.roleId === "builder");
        expect(steps).toEqual([expect.objectContaining({ profileId: "grok-high", end: "done", outcome: "Change ready" })]);
        expect(task.session.filter((line) => line.roleId === "builder").every((line) => line.step === steps[0]!.id && line.profileId === "grok-high")).toBe(true);
        expect(journeyProblems(task)).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain" }, {
      entry: "builder",
      before: (engine) => {
        engine.s.pool.limited = [
          { toolId: "claude-code", until, reason: "Claude Code's usage limit" },
          { toolId: "codex", until, reason: "Codex's usage limit" },
        ];
      },
    });
  });

  it("starts the Grok stand-in the review group already accepted, once that seat fills the pool", async () => {
    const until = Date.now() + 120_000;
    await start(async run => {
      try {
        const task = await run.done();
        const reviewers = run.fakes.received("code reviewer");
        // Claude Code is out and Codex has one seat, so one reviewer stays on Codex and the other is Grok.
        // Choosing again after the seat is reserved would start a second Codex agent on the Grok seat.
        expect(reviewers.map((entry) => run.modelOf(entry.session)).sort()).toEqual(["gpt-6.1-sol", "grok-4.7"]);
        const joined = task.session.find((line) => line.from === "system" && line.text.startsWith("Code reviewer joined · Code reviewer on Grok"));
        expect(joined?.profileId).toBe("grok-xhigh");
        expect(new Set(task.findings.flatMap((finding) => [finding.raisedBy, ...finding.confirmedBy]))).toEqual(new Set(["sol-high", "grok-xhigh"]));
        const review = task.journey!.find((step) => step.roleId === "code-reviewer")!;
        expect(new Set(review.team)).toEqual(new Set(["sol-high", "grok-xhigh"]));
        expect(joined?.step).toBe(review.id);
        expect(task.session.filter((line) => line.roleId === "code-reviewer").every((line) => line.step === review.id && review.team!.includes(line.profileId!))).toBe(true);
        expect(journeyProblems(task)).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { builder: "plain", planner: "two-opus" }, {
      entry: "review", stop: "reviewed",
      before: (engine) => {
        engine.s.pool.limited = [{ toolId: "claude-code", until, reason: "Claude Code's 5-hour limit" }];
        engine.setPoolLimit(2);
        engine.setToolCap("codex", 1);
      },
    });
  });
});
