import { usageWorlds } from "../../fixtures/usage-world.js";
import { usageCreditAgents } from "../../fixtures/usage-credit-agents.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, journeyView, usageLines, type Task } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { waitFor } from "../../fixtures.js";

const worlds = usageWorlds();
afterAll(() => worlds.close());
const start: typeof worlds.use = (body, scenario, options = {}) =>
  worlds.use(body, scenario, { sessions: (fakes) => fakeAgentSessions(fakes), ...options });

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("an agent that runs out of usage", () => {
  it("records a non-quota provider failure on the failed node and in the inbox instead of Internal error", async () => {
    const message = "API error (status 503 Service Unavailable): Please try again later";
    await start(async run => {
      try {
        const task = await waitFor(() => {
          run.answer();
          return run.find().state === "failed" && run.find();
        }, "the provider failure");
        expect(task.error).toBe(message);
        expect(task.journey!.find((node) => node.roleId === "builder" && node.end === "failed")!.reason).toBe(message);
        expect(run.engine.getState().inbox.find((item) => item.taskId === task.id && item.kind === "stuck")!.body).toBe(message);
        expect(run.engine.getState().pool.limited).toBeUndefined();
        expect(run.fakes.received("builder")).toHaveLength(1);
      } finally { await run.engine.shutdown(); }
    }, { planner: "short", builder: "plain", failure: { role: "builder", message, httpStatus: 503 } }, { entry: "builder" });
  });

  it("hands off a native Grok 402 without retrying its request or changing the weekly reading", async () => {
    const report = { toolId: "grok", kind: "seven_day", status: "allowed" as const, utilization: 0.42, at: Date.now() - 7_200_000, resetsAt: Date.now() + 86_400_000 };
    await start(async run => {
      try {
        const planned = await waitFor(() => run.find().plan, "the plan check");
        const build = planned.stages.find((stage) => stage.roleId === "builder")!;
        run.engine.setStageProfile(run.taskId, build.id, "profileIds", 0, "grok-xhigh");
        const task = await run.completed("builder");
        expect(task.builderSession!.toolId).not.toBe("grok");
        const attempts = run.fakes.received("builder");
        expect(attempts.filter((entry) => run.modelOf(entry.session) === "grok-4.7")).toHaveLength(1);
        expect(attempts[1]!.text).toContain("Grok refused the request: Grok Build usage balance exhausted");
        expect(attempts[1]!.text).toContain("Its unfinished work is in this working copy");
        expect(attempts[1]!.text).not.toContain("ran out of usage");
        expect(lines(task).some((line) => line.includes("could not continue (Grok refused the request"))).toBe(true);
        const pool = run.engine.getState().pool;
        expect(pool.usage!.find((entry) => entry.toolId === "grok")).toEqual(report);
        expect(pool.limited!.find((entry) => entry.toolId === "grok")).toEqual(expect.objectContaining({ retry: true, reason: "Grok refused the request: Grok Build usage balance exhausted" }));
        expect(usageLines(run.engine.getState(), Date.now()).find((line) => line.toolId === "grok")!.text).toContain("request refused; retry after");
      } finally { await run.engine.shutdown(); }
    }, { builder: "plain", limited: [{ model: "grok-4.7", role: "builder" }] }, {
      before: (engine) => { engine.s.pool.usage = [report]; },
    });
  });

  it("waits without a slot after a Grok request refusal, then resumes its conversation after the cooldown", async () => {
    await start(async run => {
      try {
        const waiting = await waitFor(() => {
          run.answer();
          const task = run.find();
          if (task.state === "failed") throw new Error(task.error);
          return task.state === "waiting" && task.statusLine.includes("request refused; retry after") && task;
        }, "Grok's cooldown wait");
        expect(waiting.holdsSlot).toBe(false);
        expect(waiting.agent).toBeUndefined();
        expect(waiting.statusLine).not.toContain("out until");
        expect(run.fakes.received("builder")).toHaveLength(1);
        const limit = run.engine.s.pool.limited!.find((entry) => entry.toolId === "grok")!;
        expect(limit.until - limit.at!).toBeGreaterThan(4 * 60_000);
        expect(limit.until - limit.at!).toBeLessThanOrEqual(5 * 60_000);
        const resetAt = Date.now() + 1500;
        writeFileSync(join(run.fakes.dir, "limit-grok-4.7"), String(resetAt));
        limit.until = resetAt;
        run.engine.schedule();
        await waitFor(() => {
          run.answer();
          return run.find().journey?.some((step) => step.roleId === "builder" && step.end === "done" && step.builderReturn);
        }, "the builder to resume after its cooldown");
        const builders = run.fakes.received("builder");
        expect(builders).toHaveLength(2);
        expect(new Set(builders.map((entry) => entry.session)).size).toBe(1);
        expect(run.fakes.opens().filter((entry) => entry.session === builders[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
        expect(run.find().fixing).toBe(false);
        expect(run.find().findings).toEqual([]);
      } finally { await run.engine.shutdown(); }
    }, { planner: "short", builder: "plain", reopen: "resume", limited: [{ model: "grok-4.7", role: "builder" }] }, {
      entry: "builder",
      before: (engine) => {
        engine.s.setup!.checks = [
          { id: "claude-code", status: "logged-out" },
          { id: "codex", status: "logged-out" },
          { id: "grok", status: "ready" },
        ];
      },
    });
  });

  it("credits the planner's replacement after readiness checks already moved planning to another tool", async () => {
    await start(async run => {
      try {
        const task = await waitFor(() => run.find().plan && run.find(), "the replacement planner's result");
        const turns = run.engine.tracking.log.turns({ taskId: task.id }).filter((turn) => turn.roleId === "planner");
        expect(turns[0]!.toolId).toBe("codex");
        const finished = turns.find((turn) => turn.end === "finished")!;
        expect(finished.toolId).toBe("grok");
        expect(task.plan!.plannerProfileId).toBe(finished.profileId);
        const state = run.engine.getState();
        expect(task.journey!.findLast((step) => step.roleId === "planner")!.profileId).toBe(finished.profileId);
        expect(journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.findLast((node) => node.roleId === "planner")!.profileId).toBe(finished.profileId);
        expect(task.timeline.find((entry) => entry.text.startsWith("Plan ready:"))!.profileId).toBe(finished.profileId);
        expect(task.plan!.stages.flatMap((stage) => stage.profileIds).every((id) => run.engine.profile(id)!.toolId !== "claude-code")).toBe(true);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "research-first", builder: "plain", limited: [{ model: "gpt-6.1-sol", role: "planner" }] }, {
      sessions: usageCreditAgents("planner"),
      before: (engine) => {
        engine.s.setup!.checks = [
          { id: "claude-code", status: "logged-out" },
          { id: "codex", status: "ready" },
          { id: "grok", status: "ready" },
        ];
      },
    });
  });

  for (const [role, roleId, prefix] of [["planner", "planner", "Plan ready:"], ["researcher", "researcher", "Researcher done:"], ["check finder", "check-finder", "Found how to check"]] as const) {
    it(`credits the ${role}'s completion to the stand-in`, async () => {
      await start(async run => {
        try {
          const task = await run.run(() => waitFor(() => {
            const task = run.find();
            if (task.state === "failed") throw new Error(`The task failed: ${task.error}`);
            const finished = run.engine.tracking.log.turns({ taskId: task.id }).some((turn) => turn.roleId === roleId && turn.end === "finished");
            if (finished && task.timeline.some((entry) => entry.text.startsWith(prefix))
              && (role !== "planner" || task.plan)
              && (role !== "researcher" || task.handedBack?.some((entry) => entry.roleId === roleId))) return task;
            run.answer();
            return false;
          }, `the ${role}'s completion and attribution records`, 60_000));
          const finished = run.engine.tracking.log.turns({ taskId: task.id }).find((turn) => turn.roleId === roleId && turn.end === "finished")!;
          expect(finished.toolId).toBe("codex");
          expect(task.timeline.find((entry) => entry.text.startsWith(prefix))!.profileId).toBe(finished.profileId);
          if (role === "planner") expect(task.plan!.plannerProfileId).toBe(finished.profileId);
          if (role === "researcher") expect(task.handedBack!.find((entry) => entry.roleId === roleId)!.profileId).toBe(finished.profileId);
        } finally {
          await run.engine.shutdown();
        }
      }, { planner: "research-first", builder: "plain", limited: [{ model: "opus", role }] }, { sessions: usageCreditAgents(roleId) });
    });
  }

  it("credits review votes to the verifier that finished after a model handoff", async () => {
    // With Grok signed out, the pair includes Claude Code even though its reviewer reported the finding.
    await start(async run => {
      try {
        const task = await run.done();
        const actual = run.engine.tracking.log.turns({ taskId: task.id }).find((turn) => turn.roleId === "verifier" && turn.end === "finished" && turn.modelAsked === "sonnet")!;
        expect(actual).toBeDefined();
        expect(task.findings.flatMap((finding) => finding.votes ?? []).some((vote) => vote.by === actual.profileId)).toBe(true);
        expect(task.findings.flatMap((finding) => finding.votes ?? []).some((vote) => run.engine.profile(vote.by)?.modelId === "opus")).toBe(false);
      } finally {
        await run.engine.shutdown();
      }
    }, { builder: "plain", reviewer: "important", limited: [{ model: "opus", role: "verifier", type: "seven_day_opus" }] }, {
      entry: "review", stop: "reviewed",
      before: (engine) => {
        engine.s.setup!.checks = [
          { id: "claude-code", status: "ready" },
          { id: "codex", status: "ready" },
          { id: "grok", status: "logged-out" },
        ];
      },
    });
  });

  it("drops a limited voter's place instead of borrowing another tool's vote", async () => {
    await start(async run => {
      try {
        const task = await run.done();
        const findings = task.findings.filter((entry) => entry.severity === "blocking");
        expect(findings).toHaveLength(2);
        expect(run.fakes.openings("verifier")).toHaveLength(1);
        for (const finding of findings) {
          expect(finding.votes).toHaveLength(1);
          const vote = finding.votes![0]!;
          expect(run.engine.profile(vote.by)!.toolId).toBe("claude-code");
          expect(vote.toolId).toBe("claude-code");
          expect(vote.plannedProfileId).toBe(vote.by);
          expect(vote.verdict).toBe("real");
          expect(finding.verification!.verdict).toBe("real");
          expect(finding.status).toBe("fixed");
        }
        expect(lines(task)).toContain("Sent back to the builder: 2 important");
      } finally { await run.engine.shutdown(); }
    }, { builder: "plain", reviewer: "important", verifier: "split" }, {
      entry: "review", stop: "reviewed",
      before: (engine) => {
        engine.s.setup!.checks = [
          { id: "claude-code", status: "ready" },
          { id: "codex", status: "ready" },
          { id: "grok", status: "logged-out" },
        ];
        engine.s.pool.limited = [{ toolId: "codex", until: Date.now() + 3_600_000, reason: "Codex's usage limit" }];
      },
    });
  });

  it("keeps the security review off the builder's replacement tool while another tool is available", async () => {
    await start(async run => {
      try {
        const task = await run.until(task => task.timeline.some(entry => entry.text === "Security reviewer started"), "the actual independent security reviewer to start");
        expect(task.builderSession!.toolId).toBe("codex");
        const review = task.timeline.find((entry) => entry.text === "Security reviewer started");
        expect(review).toBeDefined();
        expect(run.engine.profile(review!.profileId!)!.toolId).toBe("grok");
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", risk: "high", builder: "plain", limited: [{ model: "opus", role: "builder", spendCap: true }] });
  });

  it("keeps a real billing refusal and the turn's settings while the included session window is open", async () => {
    await start(async run => {
      try {
        const task = await run.completed("builder");
        expect(run.engine.getState().pool.usage).toEqual(expect.arrayContaining([
          expect.objectContaining({ toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0.4 }),
        ]));
        expect(run.engine.getState().pool.usage!.some(report => report.kind === "overage")).toBe(false);
        expect(run.engine.getState().pool.limited).toMatchObject([{ toolId: "claude-code", source: "refusal", reason: "Claude Code's spend limit", at: expect.any(Number) }]);
        const builders = run.engine.tracking.log.turns({ taskId: task.id }).filter((turn) => turn.roleId === "builder");
        expect(builders[0]).toMatchObject({ toolId: "claude-code", modelAsked: "opus", effortAsked: "high", modelRan: "opus", effortRan: "high", end: "agent-stopped", workMs: expect.any(Number) });
        expect(builders[0]!.tokens).toBeUndefined();
        expect(builders.some((turn) => turn.toolId === "codex" && turn.end === "finished")).toBe(true);
        const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
        expect(details.failuresByReason).toContainEqual({ label: "usage limit reached", count: 1 });
        expect(details.retries).toBe(1);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", limited: [{ model: "opus", role: "builder", spendCap: true }] }, { entry: "builder" });
  });

  it("is taken over in the same step by an agent on another tool, who is told what the first one did and said", async () => {
    await start(async run => {
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
        expect(run.engine.getState().pool.limited).toMatchObject([
          { toolId: "claude-code", source: "report", reason: "Claude Code's 5-hour limit" },
          { toolId: "claude-code", source: "refusal", reason: "Claude Code's 5-hour limit" },
        ]);
        expect(task.plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
        const actual = task.builderSession!.profileId;
        expect(task.builderSession!.plannedProfileId).toBe("opus-high");
        expect(run.engine.profile(actual)!.toolId).toBe("codex");
        const returned = task.journey!.find((step) => step.builderReturn)!;
        expect(task.timeline.find((entry) => entry.step === returned.id && entry.text.startsWith(returned.builderReturn!.outcome))!.profileId).toBe(actual);
        expect(task.lessons!.filter((lesson) => lesson.roleId === "builder").map((lesson) => lesson.profileId)).toEqual([actual, actual]);
        expect(await run.run(() => gitOps.message(run.engine.getState().products[0]!.path!, "main"))).toContain("Built by Petrina: Builder on Codex");
        const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
        expect(details.failuresByReason).toContainEqual({ label: "usage limit reached", count: 1 });
        expect(details.retries).toBe(1);
        // Each tool keeps its own work and lines, rather than the stand-in overwriting the first box.
        const steps = task.journey!.filter((step) => step.roleId === "builder");
        expect(steps).toMatchObject([
          { profileId: "opus-high", outcome: "Work handed on", reason: "another agent took over", end: "done" },
          { profileId: "sol-high", outcome: "Change ready", end: "done" },
        ]);
        expect(steps[0]!.endedAt).toBeLessThanOrEqual(steps[1]!.startedAt);
        expect(task.timeline.find((entry) => entry.text.startsWith("Builder on Claude Code") && entry.text.includes("ran out of usage"))?.step).toBe(steps[0]!.id);
        expect(task.session.find((line) => line.text.startsWith("Builder on Codex · sol took over"))?.step).toBe(steps[1]!.id);
        expect(journeyProblems(task)).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", learnings: true, limited: [{ model: "opus", role: "builder" }] });
  });

  it("is taken over by another model on the same tool when only that model is out", async () => {
    await start(async run => {
      try {
        const task = await run.completed("builder");
        const builders = run.fakes.received("builder");
        expect(builders).toHaveLength(2);
        expect(run.modelOf(builders[1]!.session)).toBe("sonnet");
        expect(lines(task)).toContain("Builder on Claude Code · Sonnet 5.5 took over from Claude Code · Opus 5.5, which ran out of usage");
        expect(run.engine.getState().pool.limited).toMatchObject([
          { toolId: "claude-code", model: "opus", source: "report", reason: "Claude Code's weekly Opus limit" },
          { toolId: "claude-code", model: "opus", source: "refusal", reason: "Claude Code's weekly Opus limit" },
        ]);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", limited: [{ model: "opus", role: "builder", type: "seven_day_opus" }] }, { entry: "builder" });
  });

  it("waits for usage when every tool is out, then goes back to its own conversation by itself", async () => {
    await start(async run => {
      try {
        const waiting = await waitFor(() => {
          const task = run.find();
          return task.state === "waiting" && task.statusLine.startsWith("Waiting for usage") && task;
        }, "the task to wait for usage");
        const reset = new Date(Math.min(...run.engine.getState().pool.limited!.map((limit) => limit.until)));
        const clock = reset.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const day = reset.toLocaleDateString("en-US", { weekday: "short" });
        const prefix = "Waiting for usage: Claude Code, Codex, Grok, Antigravity, OpenCode and Pi are out until ";
        // The reset may cross midnight; either date form remains valid if midnight passes after the status was recorded.
        expect([`${prefix}${clock}`, `${prefix}${day} ${clock}`]).toContain(waiting.statusLine);
        expect(waiting.holdsSlot).toBe(false);
        expect(waiting.agent).toBeUndefined();
        const box = waiting.journey!.at(-1)!;
        const boxId = box.id;
        const startedAt = box.startedAt;
        expect(box).toMatchObject({ roleId: "builder", profileId: "opus-high" });
        expect(box.endedAt).toBeUndefined();

        // Keep the fake limit in force until the agent has reported it and the task is visibly waiting.
        // Then shorten both fake and pool expiries together to exercise the automatic wake without
        // letting machine load consume a tiny quota window before the fake agent can report it.
        const resetAt = Date.now() + 1500;
        writeFileSync(join(run.fakes.dir, "limit-opus"), String(resetAt));
        const claudeLimits = run.engine.s.pool.limited!.filter((limit) => limit.toolId === "claude-code");
        expect(claudeLimits.map(limit => limit.source).sort()).toEqual(["refusal", "report"]);
        for (const limit of claudeLimits) limit.until = resetAt;
        run.engine.schedule();

        const task = await run.completed("builder");
        const builders = run.fakes.received("builder");
        // The same conversation, reopened: no stand-in ever started.
        expect(new Set(builders.map((entry) => entry.session)).size).toBe(1);
        expect(run.fakes.opens().filter((open) => open.session === builders[0]!.session).map((open) => open.how)).toEqual(["new", "resume"]);
        expect(builders[1]!.text).toStartWith("Petrina restarted while you were on");
        expect(lines(task).some((line) => line.includes("took over from"))).toBe(false);
        expect(lines(task)).toContain("Picked up where it left off");
        // Claude Code's limit ended and was dropped; Codex's and Grok's, set to last longer, are still there.
        expect(run.engine.getState().pool.limited?.map((limit) => limit.toolId)).toEqual(["codex", "grok", "antigravity", "opencode", "pi"]);
        expect(task.journey!.filter((step) => step.roleId === "builder")).toEqual([expect.objectContaining({ id: boxId, startedAt, end: "done" })]);
        // Picking the step up after the wait is a retry, counted once, with nothing left owed.
        const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
        expect(details.failuresByReason).toEqual([{ label: "usage limit reached", count: 1 }]);
        expect(details.retries).toBe(1);
        const retry = run.engine.tracking.log.moments({ taskId: task.id, kinds: ["retry"] });
        expect(retry).toMatchObject([{ roleId: "builder", profileId: "opus-high", toolId: "claude-code" }]);
        expect(run.engine.tracking.log.owedRetries()).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", reopen: "resume", limited: [{ model: "opus", role: "builder" }] }, {
      // Set the other tools' limits before any task can run. A late fixture update
      // must not erase Claude's already reported limit or admit a replacement.
      entry: "builder",
      before: (engine) => {
        engine.s.pool.limited = [
          { toolId: "codex", until: Date.now() + 3_600_000, reason: "Codex's usage limit" },
          { toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's rate limit" },
          { toolId: "antigravity", until: Date.now() + 3_600_000, reason: "Antigravity's usage limit" },
          { toolId: "opencode", until: Date.now() + 3_600_000, reason: "OpenCode's usage limit" },
          { toolId: "pi", until: Date.now() + 3_600_000, reason: "Pi's usage limit" },
        ];
      },
    });
  });

  it("counts a Check finder that could not finish as a failure, and carries on with the checks it has", async () => {
    await start(async run => {
      try {
        const task = await run.until((task, generation) =>
          task.timeline.some(entry => entry.text === "The Check finder could not finish, so Petrina uses no checks for now")
          && task.journey?.findLast(step => step.roleId === "check-finder")?.endedAt !== undefined
          && generation.tracking.log.moments({ taskId: task.id, kinds: ["failure"] }).some(moment => moment.roleId === "check-finder")
          && generation.s.products.find(product => product.id === task.productId)?.checksBy === "finder",
        "the actual Check finder failure, completed side turn and saved fallback");
        expect(lines(task)).toContain("The Check finder could not finish, so Petrina uses no checks for now");
        const failures = run.engine.tracking.log.moments({ taskId: task.id, kinds: ["failure"] });
        expect(failures).toMatchObject([{ outcome: "unusable", roleId: "check-finder", profileId: expect.any(String) }]);
        // Include the repair attempts and failure even when they straddle midnight or delivery
        // finishes the next day. The Guide keeper test covers Today's day-boundary filtering.
        const clock = spyOn(Date, "now").mockReturnValue(failures[0]!.at);
        try {
          const details = run.engine.usage({ view: "analytics", period: "7d" }).squad.details;
          expect(details.failuresByReason).toEqual([{ label: "unusable result", count: 1 }]);
          expect(details.redone).toBe(2);
        } finally { clock.mockRestore(); }
      } finally {
        await run.engine.shutdown();
      }
    }, { planner: "claude-build", builder: "plain", checks: "broken" }, { entry: "builder" });
  });

  it("is replaced in a group of reviewers by a stand-in, told what it had said", async () => {
    await start(async run => {
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
        const review = task.journey!.find((step) => step.roleId === "code-reviewer")!;
        expect(new Set(review.team)).toEqual(new Set(["opus-high", "sol-high", "sonnet-high"]));
        expect(task.session.filter((line) => line.roleId === "code-reviewer").every((line) => line.step === review.id && review.team!.includes(line.profileId!))).toBe(true);
        expect(journeyProblems(task)).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { builder: "plain", limited: [{ model: "opus", role: "code reviewer", type: "seven_day_opus" }] }, { entry: "review", stop: "reviewed" });
  });

  it("records only the reviewers who actually start when a planned model was already out of usage", async () => {
    await start(async run => {
      try {
        const task = await run.done();
        const review = task.journey!.find((step) => step.roleId === "code-reviewer")!;
        expect(new Set(review.team)).toEqual(new Set(["sonnet-high", "sol-high"]));
        expect(task.plan!.stages.find((stage) => stage.roleId === "code-reviewer")!.profileIds).toEqual(["opus-high", "sol-high"]);
        expect(task.session.filter((line) => line.roleId === "code-reviewer").every((line) => line.step === review.id && review.team!.includes(line.profileId!))).toBe(true);
        expect(journeyProblems(task)).toEqual([]);
      } finally {
        await run.engine.shutdown();
      }
    }, { builder: "plain" }, { entry: "review", stop: "reviewed", before: (engine) => {
      engine.s.pool.limited = [{ toolId: "claude-code", model: "opus", until: Date.now() + 120_000, reason: "Claude Code's weekly Opus limit" }];
    } });
  });
});
