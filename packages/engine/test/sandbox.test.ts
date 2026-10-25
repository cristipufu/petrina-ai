import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActiveAgent, State, Task, TaskUsage } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { Engine } from "./engine.js";
import { agentEnv } from "../src/env.js";
import { claudeSandbox } from "@petrina/agent-runtime/sandbox";
import { ADAPTERS, ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import type { Scenario } from "./fake-agent.js";
import { engineEnv, EngineProcess, Fakes, makeProduct, removeDir, tempDir, testBrowserRoot, traceTaskWait, waitFor, type Open } from "./support.js";

// Conversations started here keep their browsers, in this file's own browser folder.
const roots: string[] = [testBrowserRoot()];
const browsers = roots[0]!;
afterAll(() => roots.forEach(removeDir));

const REFUSED = "Running without Claude Code's sandbox: this computer lacks what it needs (bubblewrap (bwrap) not installed, socat not installed)";

/** A product committing to main (no shipper), a task on it, and an engine on fake agents. */
async function start(scenario: Scenario, description = "", approvePlan = false) {
  const root = tempDir("petrina-sandbox-");
  roots.push(root);
  const product = await makeProduct(root);
  const home = join(root, "home");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = await EngineProcess.harness(home, fakes.dir);
  // A task started while only one tool's check has answered is planned on that tool alone.
  await engine.until(
    (state) => ["claude-code", "codex"].every((id) => state.setup?.checks.some((check) => check.id === id && check.status === "ready" && !check.checking)),
    "Claude Code and Codex to be ready",
  );
  const productId = (await engine.act("addProduct", product)) as string;
  await engine.act("setProductDelivery", productId, "local", false);
  const taskId = (await engine.act("addTask", { productId, title: "Add a greeting", description, ...(approvePlan ? { approvePlan } : {}) })) as string;
  const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
  const finished = async (engine: EngineProcess) => find(await engine.until((state) => find(state).state === "done", "the task to finish", 60_000));
  return { home, fakes, engine, taskId, find, finished };
}

/**
 * Conversations that did the task's work. A login check also opens one and stops, without asking for
 * work or for Claude Code's sandbox, so it is not an agent's session.
 */
function taskOpens(fakes: Fakes): Open[] {
  const worked = new Set(fakes.received().map((entry) => entry.session));
  return fakes.opens().filter((open) => open.refused === true || worked.has(open.session));
}

/** Which tool each conversation that asked for work ran as, by role. */
function toolsByRole(fakes: Fakes): Map<string, Set<string>> {
  const tools = new Map(fakes.opens().map((open) => [open.session, open.tool]));
  const roles = new Map<string, Set<string>>();
  for (const entry of fakes.received()) roles.set(entry.role, (roles.get(entry.role) ?? new Set()).add(tools.get(entry.session)!));
  return roles;
}

describe("Claude Code's own sandbox", () => {
  it("every Claude Code conversation opens in it, Codex gets nothing new, and every agent has the coordinator's logins", async () => {
    const run = await start({ planner: "short", builder: "plain", controlled: true });
    const { engine, fakes } = run;
    // While the planner, on Claude Code, works: the Session tab says it is sandboxed.
    // The prompt can be recorded a moment before that status is on the agent, so wait for the status.
    await waitFor(() => fakes.received("planner")[0], "the planner to start");
    const sandboxed = await engine.until((state) => {
      const agent = run.find(state).agent;
      return agent?.roleId === "planner" && agent.sandbox !== undefined;
    }, "the planner's sandbox status");
    expect(run.find(sandboxed).agent?.sandbox).toEqual({ on: true });
    const release = setInterval(() => fakes.received().forEach((entry) => writeFileSync(join(fakes.dir, `release-${entry.session}`), "go")), 50);
    const done = await run.finished(engine).finally(() => clearInterval(release));

    // The planner works on Claude Code, the builder on Codex, and the reviewer on Claude Code.
    const roles = toolsByRole(fakes);
    expect(roles.get("planner")).toEqual(new Set(["claude-code"]));
    expect(roles.get("builder")).toEqual(new Set(["codex"]));
    expect(roles.get("code reviewer")).toEqual(new Set(["claude-code"]));
    for (const open of taskOpens(fakes)) {
      expect(open).toMatchObject({ how: "new", background: true, logins: true, quiet: true });
      expect(open.refused).toBeUndefined();
      // The same settings for every Claude Code agent, whatever its role; nothing for Codex.
      if (open.tool === "claude-code") expect(open.sandbox).toEqual(claudeSandbox());
      else expect(open.sandbox).toBeUndefined();
    }
    expect(done.session.some((line) => line.text.startsWith("Running without Claude Code's sandbox"))).toBe(false);
    await engine.quit();
  });

  it("a planner that starts while Claude Code is still being checked opens on Codex, and no usage limit caused it", async () => {
    const root = tempDir("petrina-sandbox-race-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "short", controlled: true });
    const engine = new Engine(join(root, "home"), {
      agentCommand: (profile) => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`],
    });
    try {
      // The same window the full suite hit: Codex has answered, Claude Code's check is still running.
      engine.s.setup!.checks = [
        { id: "claude-code", status: "unchecked", checking: true },
        { id: "codex", status: "ready" },
      ];
      expect(engine.onUsable("opus-high")).toBe("sol-high");
      expect(engine.s.pool.limited ?? []).toEqual([]);
      const productId = await engine.addProduct(await makeProduct(root));
      engine.setProductDelivery(productId, "local", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting" });
      const seated = await waitFor(() => {
        const task = engine.getState().tasks.find((task) => task.id === taskId);
        return task?.agent?.roleId === "planner" && task.agent.sandbox ? task : undefined;
      }, "the planner to be seated");
      const entry = await waitFor(() => fakes.received("planner")[0], "the planner to start");
      const open = fakes.opens().find((item) => item.session === entry.session);
      expect(seated.agent).toMatchObject({ profileId: "sol-high", sandbox: { on: true } });
      expect(open).toMatchObject({ tool: "codex", how: "new" });
      expect(open?.sandbox).toBeUndefined();
      expect((engine.getState().pool.limited ?? []).some((limit) => limit.toolId === "claude-code" || limit.toolId === "codex")).toBe(false);
    } finally {
      await engine.shutdown();
    }
  });

  it("when it cannot start, agents run as before, each says so once, and later ones do not try it again", async () => {
    const run = await start({ planner: "short", builder: "plain", sandbox: "unavailable", controlled: true });
    const { engine, fakes } = run;
    await waitFor(() => fakes.received("planner")[0], "the planner to start");
    const running = await engine.until((state) => {
      const agent = run.find(state).agent;
      return agent?.roleId === "planner" && agent.sandbox?.on === false;
    }, "the planner to be running without the sandbox");
    expect(run.find(running).agent?.sandbox).toEqual({ on: false, reason: "this computer lacks what it needs (bubblewrap (bwrap) not installed, socat not installed)" });
    const release = setInterval(() => fakes.received().forEach((entry) => writeFileSync(join(fakes.dir, `release-${entry.session}`), "go")), 50);
    const done = await run.finished(engine).finally(() => clearInterval(release));

    // Only the first Claude Code conversation in this run of Petrina asked for the sandbox; it opened again without it.
    const opens = taskOpens(fakes);
    expect(opens[0]).toMatchObject({ how: "new", tool: "claude-code", refused: true, sandbox: claudeSandbox() });
    expect(opens.slice(1).every((open) => open.sandbox === undefined && open.background && open.logins && open.quiet)).toBe(true);
    // One line for each Claude Code agent (the planner and reviewer), none for Codex's builder, none repeated on later turns.
    const claude = opens.filter((open) => open.tool === "claude-code" && !open.refused);
    expect(claude.length).toBeGreaterThanOrEqual(2);
    const lines = done.session.filter((line) => line.text.startsWith("Running without Claude Code's sandbox"));
    expect(lines.map((line) => line.text)).toEqual(Array(claude.length).fill(REFUSED));
    expect(lines.some((line) => line.roleId === "planner") && lines.some((line) => line.roleId === "code-reviewer")).toBe(true);
    expect(lines.some((line) => line.roleId === "builder")).toBe(false);
    await engine.quit();
  });

  for (const unavailable of [false, true]) {
    for (const voting of [false, true]) {
      it(`group ${voting ? "voters" : "reviewers"} keep each agent's sandbox status, including when the header changes${unavailable ? " without Claude Code's sandbox" : ""}`, async () => {
        // Codex reports the vote's finding, so the bounded pair is Claude Code and Grok; Antigravity gives the third answer.
        const run = await start({ planner: "pair", builder: "plain", controlled: true, ...(voting ? { reviewer: "important" as const, importantBy: "gpt-6.1-sol", verifier: "not-a-bug" as const } : {}), ...(unavailable ? { sandbox: "unavailable" as const } : {}) });
        const { engine, fakes } = run;
        if (voting) {
          await engine.until(state => Object.keys(ADAPTERS).every(id => state.setup?.checks.some(check => check.id === id && check.status === "ready" && !check.checking)), "every voter's tool to be ready");
          await engine.act("setPoolLimit", Object.keys(ADAPTERS).length);
        }
        const roleId = voting ? "verifier" : "code-reviewer";
        const promptRole = voting ? "verifier" : "code reviewer";
        const go = (role?: string) => fakes.received(role).forEach((entry) => writeFileSync(join(fakes.dir, `release-${entry.session}`), "go"));
        // Earlier stages go on; the group under test waits while the Session tab's state is inspected.
        const before = setInterval(() => ["planner", "builder", "check finder", ...(voting ? ["code reviewer"] : [])].forEach(go), 50);
        let release: ReturnType<typeof setInterval> | undefined;
        try {
          const expected = new Map<string, ActiveAgent["sandbox"]>([
            ["opus-high", unavailable ? { on: false, reason: "this computer lacks what it needs (bubblewrap (bwrap) not installed, socat not installed)" } : { on: true }],
            // A vote's pair includes Grok, with its own setup and no sandbox claim.
            voting ? ["grok-high", undefined] : ["sol-high", { on: true }],
          ]);
          const later = voting ? ["argon-high"] : [];
          const group = await traceTaskWait(!voting && unavailable ? "Reviewers without Claude Code's sandbox" : undefined, () => engine.state(), run.taskId, () => engine.until((state) => {
            const task = run.find(state);
            const agents = [task.agent, ...(task.helpers ?? [])];
            // The prompt sidecar can advance after this state snapshot was read. Wait for each
            // Claude/Codex status in the snapshot too; other tools do not report a sandbox status.
            return agents.length === expected.size && agents.every((agent) => agent?.roleId === roleId && expected.has(agent.profileId) && (expected.get(agent.profileId) === undefined || agent.sandbox !== undefined)) && fakes.received(promptRole).length === expected.size;
          }, "all group agents to start"));
          clearInterval(before);
          const task = run.find(group);
          expect(new Map([task.agent, ...(task.helpers ?? [])].map((agent) => [agent!.profileId, agent!.sandbox]))).toEqual(expected);

          // Let only the header agent finish. Its helper takes over the header with its own status intact.
          const toolId = group.profiles.find((profile) => profile.id === task.agent!.profileId)!.toolId;
          const tools = new Map(fakes.opens().map((open) => [open.session, open.tool]));
          const first = await waitFor(() => fakes.received(promptRole).find((entry) => tools.get(entry.session) === toolId), "the header agent to receive its work");
          writeFileSync(join(fakes.dir, `release-${first.session}`), "go");
          const remaining = task.helpers![0]!;
          const changed = run.find(await engine.until((state) => {
            const current = run.find(state);
            return current.agent?.profileId === remaining.profileId && current.agent.roleId === roleId && (current.helpers?.length ?? 0) === expected.size - 2;
          }, "the remaining agent to take over the header"));
          expect(changed.agent!.sandbox).toEqual(expected.get(remaining.profileId));

          release = setInterval(() => go(), 50);
          const done = await run.finished(engine);
          const sessions = new Set(fakes.received(promptRole).map((entry) => entry.session));
          expect(sessions.size).toBe(expected.size + later.length);
          for (const open of fakes.opens().filter((entry) => sessions.has(entry.session)))
            expect(open.sandbox).toEqual(open.tool === "claude-code" && !unavailable ? claudeSandbox() : undefined);
          expect(done.session.filter((line) => line.roleId === roleId && line.text === REFUSED)).toHaveLength(unavailable ? 1 : 0);
          // The sandbox status must also preserve main's work log for every member of the group.
          const usage = (await engine.act("usage", { view: "task", taskId: run.taskId })) as TaskUsage;
          const logged = usage.stages.flatMap((stage) => stage.agents).filter((agent) => agent.roleId === roleId);
          expect(new Map(logged.map((agent) => [agent.profileId, agent.turns]))).toEqual(new Map([...expected.keys(), ...later].map((profile) => [profile, 1])));
        } finally {
          clearInterval(before);
          clearInterval(release);
          await engine.quit();
        }
      });
    }
  }

  for (const swap of [
    { model: "opus", type: "seven_day_opus", replacement: "sonnet-high", peer: "sol-high", unavailable: false },
    // Codex only says the whole tool is out, so this seat moves to Grok. The Claude reviewer stays put.
    { model: "gpt-6.1-sol", replacement: "grok-high", peer: "opus-high", unavailable: true },
  ]) {
    it(`a group reviewer's usage handoff to ${swap.replacement} gets its own sandbox settings and status`, async () => {
      const run = await start({ planner: "pair", builder: "plain", controlled: true, limited: [{ model: swap.model, role: "code reviewer", ...(swap.type ? { type: swap.type } : {}) }], ...(swap.unavailable ? { sandbox: "unavailable" as const } : {}) });
      const { engine, fakes } = run;
      const go = (role?: string) => fakes.received(role).forEach((entry) => writeFileSync(join(fakes.dir, `release-${entry.session}`), "go"));
      const before = setInterval(() => ["planner", "builder", "check finder"].forEach(go), 50);
      let release: ReturnType<typeof setInterval> | undefined;
      try {
        const group = await engine.until((state) => {
          const task = run.find(state);
          const agents = [task.agent, ...(task.helpers ?? [])];
          const toolOf = (profileId: string | undefined) => state.profiles.find((profile) => profile.id === profileId)?.toolId;
          // Grok keeps its own setup and never shows a sandbox. Claude and Codex always do.
          const settled = (agent: (typeof agents)[number]) => agent?.roleId === "code-reviewer" && (toolOf(agent.profileId) === "grok" ? agent.sandbox === undefined : Boolean(agent.sandbox));
          return agents.length === 2 && agents.every(settled) && agents.some((agent) => agent?.profileId === swap.replacement) && fakes.received("code reviewer").length === 3;
        }, "the replacement reviewer to work beside its peer");
        clearInterval(before);
        const task = run.find(group);
        const agents = [task.agent!, ...(task.helpers ?? [])];
        expect(agents.map((agent) => agent.profileId).sort()).toEqual([swap.replacement, swap.peer].sort());
        const sandboxFor = (profileId: string) => {
          const toolId = group.profiles.find((profile) => profile.id === profileId)?.toolId;
          if (toolId === "codex") return { on: true as const };
          if (toolId === "claude-code") return swap.unavailable ? { on: false as const, reason: REFUSED.split(": ")[1]! } : { on: true as const };
          return undefined;
        };
        for (const agent of agents) expect(agent.sandbox).toEqual(sandboxFor(agent.profileId));
        const reviewers = new Set(fakes.received("code reviewer").map((entry) => entry.session));
        for (const open of fakes.opens().filter((entry) => reviewers.has(entry.session))) {
          expect(open).toMatchObject({ logins: true, quiet: true, background: true });
          expect(open.sandbox).toEqual(open.tool === "claude-code" && !swap.unavailable ? claudeSandbox() : undefined);
        }
        const replacement = fakes.received("code reviewer").find((entry) => entry.text.includes("was doing this part of the review and ran out of usage"));
        expect(replacement).toBeDefined();
        expect(fakes.opens().find((open) => open.session === replacement!.session)?.tool).toBe(group.profiles.find((profile) => profile.id === swap.replacement)!.toolId);
        release = setInterval(() => go(), 50);
        const done = await run.finished(engine);
        const claudeReviewers = agents.filter((agent) => group.profiles.find((profile) => profile.id === agent.profileId)?.toolId === "claude-code");
        expect(done.session.filter((line) => line.roleId === "code-reviewer" && line.text === REFUSED)).toHaveLength(swap.unavailable ? claudeReviewers.length : 0);
      } finally {
        clearInterval(before);
        clearInterval(release);
        await engine.quit();
      }
    });
  }

  it("a Grok reviewer keeps auto mode and gets no Claude Code sandbox settings or sandbox label", async () => {
    const run = await start({ planner: "short", builder: "plain", controlled: true, sandbox: "unavailable" });
    const { engine, fakes } = run;
    const go = (role?: string) => fakes.received(role).forEach((entry) => writeFileSync(join(fakes.dir, `release-${entry.session}`), "go"));
    const before = setInterval(() => ["planner", "check finder"].forEach(go), 50);
    let release: ReturnType<typeof setInterval> | undefined;
    try {
      await waitFor(() => fakes.received("builder")[0], "the builder to start");
      const review = run.find(await engine.state()).plan!.stages.find((stage) => stage.kind === "review-chain")!;
      await engine.act("setStageProfile", run.taskId, review.id, "profileIds", 0, "grok-high");
      go("builder");
      const state = await engine.until((state) => run.find(state).agent?.profileId === "grok-high" && fakes.received("code reviewer").length === 1, "the Grok reviewer to receive its work");
      expect(run.find(state).agent!.sandbox).toBeUndefined();
      const reviewer = fakes.received("code reviewer")[0]!;
      expect(fakes.opens().find((open) => open.session === reviewer.session)).toEqual({ session: reviewer.session, how: "new", tool: "grok", autoMode: true, logins: true, quiet: true, background: true });
      release = setInterval(() => go(), 50);
      const done = await run.finished(engine);
      expect(done.session.some((line) => line.profileId === "grok-high" && line.text.startsWith("Running without Claude Code's sandbox"))).toBe(false);
    } finally {
      clearInterval(before);
      clearInterval(release);
      await engine.quit();
    }
  });

  for (const how of ["resume", "load"] as const) {
    it(`sandboxed sessions keep confirmed settings and token reports on new and ${how}`, async () => {
      const root = tempDir("petrina-sandbox-usage-");
      roots.push(root);
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ reopen: how, planner: "short" });
      const start = (session?: string) => AgentRun.start({
        profile: ENGINE_PROFILES.find((profile) => profile.id === "opus-high")!,
        command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, "--tool=claude-code"],
        cwd: root,
        env: agentEnv(engineEnv(join(root, "home"))),
        sandbox: claudeSandbox(),
        browserTempRoot: browsers,
        signal: new AbortController().signal,
        ...(session ? { reopen: session } : {}),
        callbacks: { onActivity: () => {}, onPlanStep: () => {}, onPermission: async () => "deny" },
      });
      let run: AgentRun | undefined;
      try {
        run = await start();
        const session = run.sessionId;
        for (const reopened of [false, true]) {
          if (reopened) {
            await run.stop();
            run = await start(session);
            expect(run.reopened).toBe(how);
          }
          expect(run.settings).toEqual({ model: "opus", modelName: "Opus 5.5", effort: "high" });
          const result = await run.prompt("You are the Planner in Petrina. Plan a greeting.");
          expect(result.report).toMatchObject({ main: { total: 1170 }, models: [{ model: "claude-opus-5-5", counts: { total: 1170 } }] });
          expect(result.modelSeen).toBe("claude-opus-5-5");
        }
        expect(fakes.opens()).toEqual((["new", how] as const).map((how) => ({ session, how, tool: "claude-code", sandbox: claudeSandbox(), logins: true, quiet: true, background: true })));
      } finally {
        await run?.stop();
      }
    });

    it(`Grok keeps its own session metadata on new and ${how}, even when sandbox settings are supplied`, async () => {
      const root = tempDir("petrina-grok-session-");
      roots.push(root);
      const fakes = new Fakes(join(root, "fake"));
      // Any leaked sandbox option would refuse the conversation before it opens.
      fakes.scenario({ reopen: how, sandbox: "unavailable" });
      const start = (session?: string) => AgentRun.start({
        profile: ENGINE_PROFILES.find((profile) => profile.id === "grok-high")!,
        command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, "--record-tool=grok"],
        cwd: root,
        env: agentEnv(engineEnv(join(root, "home"))),
        sandbox: claudeSandbox(),
        browserTempRoot: browsers,
        signal: new AbortController().signal,
        ...(session ? { reopen: session } : {}),
        callbacks: { onActivity: () => {}, onPlanStep: () => {}, onPermission: async () => "deny" },
      });
      let run: AgentRun | undefined;
      try {
        run = await start();
        const session = run.sessionId;
        await run.stop();
        run = await start(session);
        expect(run.reopened).toBe(how);
        expect(fakes.opens()).toEqual((["new", how] as const).map((how) => ({ session, how, tool: "grok", autoMode: true, logins: true, quiet: true, background: true })));
      } finally {
        await run?.stop();
      }
    });
  }

  it("a reopened conversation whose sandbox cannot start is reopened without it, not started fresh", async () => {
    const run = await start({ builder: "plain", reopen: "resume", sandbox: "unavailable" }, "[no-check]");
    let engine = run.engine;
    const asked = await engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "question"), "the architect's question");
    const question = asked.inbox.find((item) => item.taskId === run.taskId)!;
    await engine.quit();
    engine = await EngineProcess.harness(run.home, run.fakes.dir);
    await engine.act("answer", question.id, "Formal", { taskId: run.taskId, about: question.title, clientId: "answer-1" });
    const done: Task = await run.finished(engine);

    const session = run.fakes.received("architect")[0]!.session;
    expect(run.fakes.received("architect").every((entry) => entry.session === session)).toBe(true);
    // The new Petrina tried the sandbox again, was refused on resume, and resumed the same conversation without it.
    expect(run.fakes.opens().filter((open) => open.session === session)).toEqual([
      { session, how: "new", tool: "claude-code", background: true, logins: true, quiet: true },
      { session, how: "resume", tool: "claude-code", background: true, logins: true, quiet: true, sandbox: claudeSandbox(), refused: true },
      { session, how: "resume", tool: "claude-code", background: true, logins: true, quiet: true },
    ]);
    expect(done.timeline.some((entry) => entry.text === "Picked up where it left off")).toBe(true);
    expect(done.timeline.some((entry) => entry.text.startsWith("Started this step again"))).toBe(false);
    // Said once for the conversation: not again when it is reopened.
    expect(done.session.filter((line) => line.roleId === "architect" && line.text === REFUSED)).toHaveLength(1);
    await engine.quit();
  });

  it("a Claude Code builder going back to its own conversation for a fix round does not say it again", async () => {
    const run = await start({ builder: "plain", reviewer: "important", reopen: "resume", sandbox: "unavailable" }, "[no-check]", true);
    const { engine, fakes } = run;
    // The builder works on Claude Code: set at the plan check, before it starts.
    const asked = await engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "plan"), "the plan check");
    const build = run.find(asked).plan!.stages.find((stage) => stage.roleId === "builder")!;
    await engine.act("setStageProfile", run.taskId, build.id, "profileIds", 0, "opus-high");
    await engine.act("approve", asked.inbox.find((item) => item.taskId === run.taskId && item.kind === "plan")!.id);
    const question = (await engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "question"), "the architect's question")).inbox.find((item) => item.taskId === run.taskId && item.kind === "question")!;
    await engine.act("answer", question.id, "Formal", { taskId: run.taskId, about: question.title, clientId: "answer-1" });
    const done = await run.finished(engine);

    expect(done.timeline.some((entry) => entry.text === "Went back to its own conversation from the last step")).toBe(true);
    const sessions = new Set(fakes.received("builder").map((entry) => entry.session));
    expect(sessions.size).toBe(1);
    const session = [...sessions][0]!;
    expect(fakes.opens().filter((open) => open.session === session).map((open) => ({ how: open.how, tool: open.tool, sandbox: open.sandbox }))).toEqual([
      { how: "new", tool: "claude-code", sandbox: undefined },
      { how: "resume", tool: "claude-code", sandbox: undefined },
    ]);
    expect(done.session.filter((line) => line.roleId === "builder" && line.text === REFUSED)).toHaveLength(1);
    await engine.quit();
  });
});
