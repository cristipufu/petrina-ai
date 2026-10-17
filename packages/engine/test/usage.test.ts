import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { AgentProfile, Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { claudeReport, claudeReports, clockTime, limitFromFailure, limitFromReport, UsageLimited } from "../src/usage.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** One task on fake agents, delivering locally, with every tool counted as installed. */
async function start(scenario: Scenario, options: { description?: string; before?: (engine: Engine) => void } = {}) {
  const root = tempDir("petrina-usage-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => "/bin/true" });
  options.before?.(engine);
  const productId = await engine.addProduct(makeProduct(root));
  engine.setProductDelivery(productId, "local", false);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: options.description ?? "[no-check]" });
  const find = () => engine.getState().tasks.find((task) => task.id === taskId) as Task;
  // The coordinator answers whatever is asked on the way.
  const answer = () => {
    for (const item of engine.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  const done = () =>
    waitFor(() => {
      answer();
      const task = find();
      if (task.state === "failed") throw new Error(`The task failed: ${task.error}`);
      return task.state === "done" && task;
    }, "the task to finish", 60_000);
  const modelOf = (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice("model=".length);
  return { engine, fakes, find, done, answer, modelOf, taskId };
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("an agent that runs out of usage", () => {
  it("is taken over in the same step by an agent on another tool, who is told what the first one did and said", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", limited: [{ model: "opus", role: "builder" }] });
    try {
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(2);
      expect(builders[1]!.session).not.toBe(builders[0]!.session);
      expect(run.modelOf(builders[0]!.session)).toBe("opus");
      expect(run.modelOf(builders[1]!.session)).toBe("gpt-6.1-sol");

      // A fresh conversation, with the step's instructions and what it needs to carry on.
      const opening = builders[1]!.text;
      expect(opening).toContain("You are the Builder in Petrina");
      expect(opening).toContain("Claude Code · Opus 5.5 was doing this step");
      expect(opening).toContain("ran out of usage. Its unfinished work is in this working copy, not committed: continue from it, don't start over.");
      expect(opening).toContain("I drafted notes.txt and started on the greeting file before running out.");
      expect(opening).toMatch(/Files added, changed or removed[^]*notes\.txt/);
      expect(opening).toContain("- Drafting the greeting");

      expect(lines(task)).toContain("Builder on Claude Code · Opus 5.5 ran out of usage (Claude Code's 5-hour limit), until " + lines(task).find((line) => line.includes("ran out of usage"))!.split(", until ")[1]);
      expect(lines(task)).toContain("Builder on Codex · sol took over from Claude Code · Opus 5.5, which ran out of usage");
      expect(task.session.some((line) => line.from === "system" && line.text.startsWith("Builder on Codex · sol took over from Claude Code"))).toBe(true);
      // Who is out is kept, and the plan is not rewritten.
      expect(run.engine.getState().pool.limited).toMatchObject([{ toolId: "claude-code", reason: "Claude Code's 5-hour limit" }]);
      expect(task.plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
    } finally {
      run.engine.shutdown();
    }
  });

  it("is taken over by another model on the same tool when only that model is out", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", limited: [{ model: "opus", role: "builder", type: "seven_day_opus" }] });
    try {
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(2);
      expect(run.modelOf(builders[1]!.session)).toBe("sonnet");
      expect(lines(task)).toContain("Builder on Claude Code · Sonnet 5.5 took over from Claude Code · Opus 5.5, which ran out of usage");
      expect(run.engine.getState().pool.limited).toMatchObject([{ toolId: "claude-code", model: "opus", reason: "Claude Code's weekly Opus limit" }]);
    } finally {
      run.engine.shutdown();
    }
  });

  it("waits for usage when every tool is out, then goes back to its own conversation by itself", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", reopen: "resume", limited: [{ model: "opus", role: "builder", resetsInMs: 2500 }] });
    try {
      // Codex is out for longer than Claude Code, so only Claude Code's own conversation can carry on.
      await waitFor(() => run.find().plan, "the plan");
      run.engine.s.pool.limited = [{ toolId: "codex", until: Date.now() + 120_000, reason: "Codex's usage limit" }];
      const waiting = await waitFor(() => {
        const task = run.find();
        return task.state === "waiting" && task.statusLine.startsWith("Waiting for usage") && task;
      }, "the task to wait for usage");
      expect(waiting.statusLine).toMatch(/^Waiting for usage: Claude Code and Codex are out until \d\d:\d\d$/);
      expect(waiting.holdsSlot).toBe(false);
      expect(waiting.agent).toBeUndefined();

      const task = await run.done();
      const builders = run.fakes.received("builder");
      // The same conversation, reopened: no stand-in ever started.
      expect(new Set(builders.map((entry) => entry.session)).size).toBe(1);
      expect(run.fakes.opens().filter((open) => open.session === builders[0]!.session).map((open) => open.how)).toEqual(["new", "resume"]);
      expect(builders[1]!.text).toStartWith("Petrina restarted while you were on");
      expect(lines(task).some((line) => line.includes("took over from"))).toBe(false);
      expect(lines(task)).toContain("Picked up where it left off");
      // Claude Code's limit ended and was dropped; Codex's, set to last longer, is still there.
      expect(run.engine.getState().pool.limited?.map((limit) => limit.toolId)).toEqual(["codex"]);
    } finally {
      run.engine.shutdown();
    }
  });

  it("is replaced in a group of reviewers by a stand-in, told what it had said", async () => {
    const run = await start({ builder: "plain", limited: [{ model: "opus", role: "code reviewer", type: "seven_day_opus" }] });
    try {
      const task = await run.done();
      const reviewers = run.fakes.received("code reviewer");
      const standIn = reviewers.find((entry) => run.modelOf(entry.session) === "sonnet");
      expect(standIn).toBeDefined();
      expect(standIn!.text).toContain("You are the Code reviewer in Petrina");
      expect(standIn!.text).toContain("Claude Code · Opus 5.5 was doing this part of the review and ran out of usage");
      expect(standIn!.text).toContain("I drafted notes.txt and started on the greeting file before running out.");
      expect(reviewers.filter((entry) => run.modelOf(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(lines(task)).toContain("Code reviewer on Claude Code · Sonnet 5.5 took over from Claude Code · Opus 5.5, which ran out of usage");
      // Both reviewers reported, the stand-in under its own profile.
      expect(new Set(task.findings.flatMap((finding) => [finding.raisedBy, ...finding.confirmedBy]))).toEqual(new Set(["sol-high", "sonnet-high"]));
    } finally {
      run.engine.shutdown();
    }
  });
});

describe.concurrent("usage reports", () => {
  it("land in the pool, the latest per tool and kind of limit", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", usage: [{ model: "opus", status: "allowed", utilization: 0.4, type: "seven_day" }] });
    try {
      await run.done();
      const usage = run.engine.getState().pool.usage!;
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ toolId: "claude-code", kind: "seven_day", status: "allowed", utilization: 0.4 });
    } finally {
      run.engine.shutdown();
    }
  });

  it("move new agents to an equal profile on another tool once a tool is at 90% or warns, without touching the plan", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", usage: [{ model: "opus", status: "allowed_warning", utilization: 0.93 }] });
    try {
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(1);
      // The planner (Claude Code) reported the warning; the builder, planned on Claude Code, went to Codex.
      expect(run.modelOf(builders[0]!.session)).toBe("gpt-6.1-sol");
      expect(task.plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
      expect(run.engine.getState().pool.limited ?? []).toEqual([]);
    } finally {
      run.engine.shutdown();
    }
  });
});

describe("what the tools say about usage", () => {
  const claude: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" };
  const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" };
  const now = new Date(2026, 9, 17, 15, 0, 0).getTime();

  it("reads Claude Code's rate limit report, with the reset time in milliseconds", () => {
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "seven_day_opus", utilization: 0.82 } })).toEqual({ toolId: "claude-code", kind: "seven_day_opus", status: "allowed_warning", model: "opus", utilization: 0.82, resetsAt: 1_800_000_000_000 });
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "rejected" } })).toEqual({ toolId: "claude-code", kind: "limit", status: "rejected" });
    // The spend cap is its own field. It can be rejected while the session window is still open.
    expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, overageStatus: "rejected", overageResetsAt: 1_800_000_000 } })).toEqual([
      { toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.95 },
      { toolId: "claude-code", kind: "overage", status: "rejected", resetsAt: 1_800_000_000_000 },
    ]);
    expect(claudeReport("claude-code", {})).toBeUndefined();
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "whatever" } })).toBeUndefined();
  });

  it("says when a rejected report has no reset time: half an hour from now", () => {
    const error = limitFromReport(claude, { toolId: "claude-code", kind: "seven_day_opus", status: "rejected", model: "opus" }, now);
    expect(error).toBeInstanceOf(UsageLimited);
    expect(error).toMatchObject({ toolId: "claude-code", model: "opus", until: now + 30 * 60_000, reason: "Claude Code's weekly Opus limit" });
  });

  it("reads Codex's failure and the time it says to try again at", () => {
    const failure = { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded", category: "quota_exhausted" } };
    const error = limitFromFailure(codex, failure, "You've hit your usage limit. Try again at 5:42 PM.", now);
    expect(error).toMatchObject({ toolId: "codex", reason: "Codex's usage limit", until: new Date(2026, 9, 17, 17, 42).getTime() });
    // No time given: half an hour.
    expect(limitFromFailure(codex, failure, "", now)!.until).toBe(now + 30 * 60_000);
    // Any other failure is not a usage limit.
    expect(limitFromFailure(codex, new Error("The agent stopped (exit 1)"), "Working on it", now)).toBeUndefined();
  });

  it("reads a failed turn by its code, and Claude's sentence only when the code is missing", () => {
    // The spend cap's code. No sentence required.
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "billing_error" } }, "Working on it", now)).toMatchObject({ toolId: "claude-code", reason: "Claude Code's spend limit", until: now + 30 * 60_000 });
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "rate_limit" } }, "", now)?.reason).toBe("Claude Code's rate limit");
    // A synthetic usage-limit message has no errorKind. The adapter wraps Claude's sentence, which names the reset.
    const said = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 8:10pm (Europe/Bucharest)";
    const error = limitFromFailure(claude, new Error(`Internal error: ${said}`), "", now);
    expect(error).toMatchObject({ toolId: "claude-code", reason: "Claude Code's usage limit", until: new Date(2026, 9, 17, 20, 10).getTime() });
    expect(error?.model).toBeUndefined();
    // Some other internal error is not a usage limit, even if the agent mentioned a limit.
    expect(limitFromFailure(claude, new Error("Internal error: the tool crashed"), "You've hit your stride", now)).toBeUndefined();
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "server_error" } }, "", now)).toBeUndefined();
  });

  it("takes the next time the clock shows what it says", () => {
    expect(clockTime("try again at 9:05 AM", now)).toBe(new Date(2026, 9, 18, 9, 5).getTime());
    expect(clockTime("Try again at 12:30 pm", now)).toBe(new Date(2026, 9, 18, 12, 30).getTime());
    expect(clockTime("try again at 16:00", now)).toBe(new Date(2026, 9, 17, 16, 0).getTime());
    expect(clockTime("your session limit resets 8:10pm (Europe/Bucharest)", now)).toBe(new Date(2026, 9, 17, 20, 10).getTime());
    expect(clockTime("later", now)).toBeUndefined();
  });
});
