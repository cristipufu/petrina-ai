import { describe, expect, it } from "bun:test";
import { checkOf } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Fakes, makeProduct } from "../../support.js";
import { setupFixtures } from "../../fixtures/setup.js";

const { fresh, agents, until, status, taskOf, toolsUsed, LIMIT, noGh, run } = setupFixtures();

describe("The squad uses tools that are ready", () => {
it("keeps usage replacements on tools allowed by the login checks, including an unconfirmed tool when none is Ready", async () => {
    const engine = new Engine(fresh("usage-data"));
    const until = Date.now() + 60_000;
    try {
      for (const checks of [
        [{ id: "claude-code", status: "ready" }, { id: "codex", status: "logged-out" }],
        [{ id: "claude-code", status: "ready" }, { id: "codex", status: "unknown" }],
        [{ id: "claude-code", status: "unknown" }, { id: "codex", status: "not-installed" }],
      ] as const) {
        engine.s.setup!.checks = checks.map((check) => ({ ...check }));
        // An exhausted tool never hands the step to a logged-out, missing, or lower-priority tool.
        engine.s.pool.limited = [{ toolId: "claude-code", until, reason: "Usage limit" }];
        expect(engine.choose("opus-high")).toMatchObject({ kind: "none" });
        // A limit on just Opus can still use the same tool's standby model.
        engine.s.pool.limited[0]!.model = "opus";
        expect(engine.choose("opus-high")).toMatchObject({ kind: "substitute", profile: { id: "sonnet-high", toolId: "claude-code" } });
      }
      engine.s.setup!.checks = [{ id: "claude-code", status: "ready" }, { id: "codex", status: "ready" }];
      engine.s.pool.limited = [{ toolId: "claude-code", until, reason: "Usage limit" }];
      expect(engine.choose("opus-high")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
    } finally {
      await engine.shutdown();
    }
  });
it("keeps plans exactly as they were when both tools are ready", async () => {
    const { engine, taskId } = await run({});
    try {
      const state = await until(engine, (current) => !!taskOf(current, taskId).plan);
      const task = taskOf(state, taskId);
      expect(task.plan!.plannerProfileId).toBe("opus-high");
      expect(task.plan!.stages.map((stage) => [stage.roleId, [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])]])).toEqual([
        ["architect", ["opus-xhigh", "sol-xhigh"]],
        ["architect", []],
        ["builder", ["sol-xhigh"]],
        ["code-reviewer", ["opus-high", "sol-high"]],
        ["release-manager", ["opus-high"]],
      ]);
    } finally {
      await engine.shutdown();
    }
  });
it("counts a logged-in Grok, which sends no login report, as Ready at once, so it still stands in when the others run out of usage", async () => {
    const engine = new Engine(fresh("data"), { agentCommand: agents({ grok: "ok" }), which: noGh, toolCheckTimeoutMs: LIMIT });
    try {
      const from = Date.now();
      await engine.checkTools();
      // Grok's answer is the conversation opening, not a report that never comes: no wait for the time limit.
      expect(Date.now() - from).toBeLessThan(LIMIT - 1_000);
      for (const id of ["claude-code", "codex", "grok"] as const) expect(status(engine, id)).toBe("ready");
      expect(checkOf(engine.getState().setup?.checks, "grok").detail).toBeUndefined();
      expect(engine.usableTools()).toEqual(["claude-code", "codex", "grok"]);
      // Claude Code and Codex both out of usage: Grok takes the step, as on main.
      engine.s.pool.limited = [
        { toolId: "claude-code", until: Date.now() + 120_000, reason: "Claude Code's usage limit" },
        { toolId: "codex", until: Date.now() + 120_000, reason: "Codex's usage limit" },
      ];
      const choice = engine.choose("opus-xhigh");
      expect(choice?.kind).toBe("substitute");
      expect(choice?.kind === "substitute" && choice.profile.toolId).toBe("grok");
    } finally {
      await engine.shutdown();
    }
  });
it("shows a logged-out Grok as Not logged in: it refuses the conversation, as the real one does", async () => {
    const fakes = new Fakes(fresh("fakes"));
    const engine = new Engine(fresh("data"), { agentCommand: agents({ grok: "logged-out" }, fakes.dir), which: noGh, toolCheckTimeoutMs: LIMIT });
    try {
      await engine.checkTools();
      expect(status(engine, "grok")).toBe("logged-out");
      expect(status(engine, "claude-code")).toBe("ready");
      expect(engine.usableTools()).toEqual(["claude-code", "codex"]);
      expect(fakes.prompts()).toEqual([]);
    } finally {
      await engine.shutdown();
    }
  });
it("tries a tool it couldn't check when none is ready, and names it in a Stuck item when it will not start", async () => {
    const { engine, taskId } = await run({ "claude-code": "logged-out", codex: "wont-start" });
    try {
      expect(status(engine, "claude-code")).toBe("logged-out");
      expect(status(engine, "codex")).toBe("unknown");
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item.toolId).toBe("codex");
      expect(item.title).toContain("Codex wouldn't start");
      expect(item).toMatchObject({ toolProblem: "wont-start" });
      expect(item.body).toContain("to see whether Codex works");
      const task = taskOf(state, taskId);
      expect(task.timeline.filter((entry) => entry.text === "Planner started" && entry.profileId === "sol-high")).toHaveLength(1);
      const planner = task.journey!.find((step) => step.roleId === "planner")!;
      expect(planner).toMatchObject({ profileId: "sol-high", end: "failed", outcome: "Stuck", reason: task.error });
      expect(task.timeline.find((entry) => entry.text === "Stuck: Codex wouldn't start")?.step).toBe(planner.id);
      expect(task.journey!.at(-1)).toMatchObject({ kind: "you", waitsFor: "stuck" });
      // Never on the tool that is not logged in.
      expect(toolsUsed(engine, task).has("claude-code")).toBe(false);
    } finally {
      await engine.shutdown();
    }
  });
it("gives up on a tool that hangs as it starts, and names it in a Stuck item with its fix and what happened", async () => {
    // Readiness is unknown immediately; this case exercises the real agent-start deadline, not another readiness wait.
    const command = agents({ "claude-code": "logged-out", codex: "hang" })!;
    const { engine, taskId } = await run({ "claude-code": "logged-out", codex: "hang" }, { startTimeoutMs: 1_500, agentCommand: (profile) => profile.toolId === "codex" ? [...command(profile)!, "--exit-in-checks"] : command(profile) });
    try {
      expect(status(engine, "claude-code")).toBe("logged-out");
      expect(status(engine, "codex")).toBe("unknown");
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item).toMatchObject({ toolId: "codex", toolProblem: "wont-start" });
      expect(item.title).toContain("Codex wouldn't start");
      expect(item.body).toContain("to see whether Codex works");
      expect(item.detail).toContain("Codex did not start within 2 seconds");
      expect(taskOf(state, taskId)).toMatchObject({ state: "failed", statusLine: "Stuck: Codex wouldn't start" });
      expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === "Planner started" && entry.profileId === "sol-high")).toHaveLength(1);
    } finally {
      await engine.shutdown();
    }
  });
it("raises a Stuck item for a tool that is not logged in, and Retry checks it again before trying", async () => {
    const fakes = new Fakes(fresh("fakes"));
    // Only Codex, and it is logged out: nothing usable, so the planner's own tool is named.
    const engine = new Engine(fresh("data"), { agentCommand: agents({ codex: "logged-out", "claude-code": "logged-out" }, fakes.dir), toolCheckTimeoutMs: LIMIT });
    try {
      await engine.checkTools();
      const productId = await engine.addProduct(await makeProduct(fresh("product")));
      const taskId = engine.addTask({ productId, title: "Add a greeting" });
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item.toolId).toBe("claude-code");
      expect(item).toMatchObject({ toolProblem: "logged-out" });
      expect(item.title).toContain("Claude Code isn't logged in");
      expect(item.body).toContain("not logged in");
      // Petrina never started the agent: its fix came first.
      expect(fakes.prompts()).toEqual([]);
      // No agent ever started: show only the wait for the coordinator, never a failed agent box.
      expect(taskOf(state, taskId).journey).toEqual([expect.objectContaining({ kind: "you", waitsFor: "stuck" })]);
      await engine.retry(item.id);
      expect(engine.getState().inbox.some((entry) => entry.id === item.id)).toBe(true);
      expect(taskOf(engine.getState(), taskId).timeline.at(-1)?.text).toBe("Checked Claude Code again: it is still not logged in");
    } finally {
      await engine.shutdown();
    }
  });
});
