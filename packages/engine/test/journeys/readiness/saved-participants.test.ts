import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endAgentStep, slotUses, slotWait, type AgentProfile, type CheckId } from "@petrina/core";

import { executionFor, type ToolProbe } from "@petrina/orchestrator";
import { WaitingForUsage } from "../../../src/usage.js";
import { BuildResult } from "../../../src/roles.js";
import { Fakes, createProductRepository, SLOW, waitFor } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


const OLD = 10 * 60_000;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** An engine whose agents and readiness checks run the fake tool in `root`, keeping its data there across restarts. */
function engineIn(caseOwner: EngineCaseOwner, root: string, checkTimeoutMs = 8_000 * SLOW, nativeProbe = false) {
  const fakes = new Fakes(join(root, "fake"));
  // Flags each tool's next readiness check gets; agent turns ignore them.
  const inChecks: Record<string, string[]> = {};
  const name = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", antigravity: "Antigravity" } as Record<string, string>;
  const baseProbe = privateAgentToolProbe();
  const scriptedProbe: ToolProbe = {
    absent: (id) => baseProbe.absent(id),
    async run(id, request) {
      if (id === "git" || id === "node" || id === "gh") return baseProbe.run(id, request);
      const flags = [...(inChecks[id] ?? [])];
      appendFileSync(join(fakes.dir, "checks.jsonl"), `${JSON.stringify({ pid: process.pid, tool: id })}\n`);
      const holdFlag = flags.find((flag) => flag.startsWith("--hold-open-in-checks="));
      const hang = flags.includes("--hang-in-checks");
      if (holdFlag || hang) {
        const holdFile = holdFlag?.slice("--hold-open-in-checks=".length);
        if (holdFile) writeFileSync(`${holdFile}.reached`, "1");
        const deadline = Date.now() + checkTimeoutMs;
        while (!request.signal.aborted && Date.now() < deadline && (hang || (holdFile ? existsSync(holdFile) : false))) {
          await Bun.sleep(10);
        }
        if (request.signal.aborted || Date.now() >= deadline || hang) {
          return { status: "unknown", detail: `${name[id] ?? id} did not answer within ${Math.round(checkTimeoutMs / 1000)} seconds.` };
        }
      }
      if (flags.includes("--logged-out-in-checks")) return { status: "logged-out" };
      if (request.signal.aborted) {
        return { status: "unknown", detail: `${name[id] ?? id} did not answer within ${Math.round(checkTimeoutMs / 1000)} seconds.` };
      }
      return { status: "ready" };
    },
  };
  const engine = caseOwner.open(join(root, "data"), {
    agentCommand: (profile) => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`, ...(inChecks[profile.toolId] ?? [])],
    startAgentSession: fakeAgentSessions(fakes, {
      recordTool: true,
      flags: (toolId) => inChecks[toolId] ?? [],
    }),
    ...(!nativeProbe ? { toolProbe: scriptedProbe } : {}),
    toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
    toolCheckTimeoutMs: checkTimeoutMs,
  });
  installSharedWorkflowFastPaths(engine, {
    skipUpToDate: true,
    skipPrepareChecks: true,
    skipReviewCopies: true,
    skipReviewInputDiffs: true,
    fastCheckCapture: true,
  });
  engine.schedule = () => {};
  const checks = () => existsSync(join(fakes.dir, "checks.jsonl"))
    ? readFileSync(join(fakes.dir, "checks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; tool: string }) : [];
  const check = (toolId: string) => engine.s.setup!.checks.find((entry) => entry.id === toolId)!;
  /** The tool's last answer was Couldn't check, ten minutes ago, as after a startup check that timed out. */
  const uncertain = (toolId: string) => Object.assign(check(toolId), { status: "unknown", at: Date.now() - OLD, detail: `${name[toolId]} did not answer within 30 seconds` });
  /** The tool's next check opens its conversation only once `release` is called. */
  const holdCheck = (toolId: string) => {
    const file = join(root, `hold-${toolId}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, "");
    inChecks[toolId] = [`--hold-open-in-checks=${file}`];
    return { reached: (during?: PromiseLike<unknown>) => waitFor(() => existsSync(`${file}.reached`), `${toolId}'s held readiness check`, undefined, { during }), release: () => rmSync(file, { force: true }) };
  };
  return { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name };
}

// Native probe death is independent of the portable group's decision about the now-unavailable seat.
it("records an unknown readiness answer when a native probe dies while opening its conversation", async () => {
  return engineCases.use("petrina-readiness-probe-exit-", async owner => {
    const f = engineIn(owner, owner.root, undefined, true), held = f.holdCheck("grok");
    owner.onStop(held.release);
    const checking = owner.run(f.engine, () => f.engine["tools"].check("grok"));
    try {
      await held.reached(checking);
      const probe = f.checks().find(check => check.tool === "grok")!;
      expect(alive(probe.pid)).toBe(true);
      process.kill(probe.pid, "SIGKILL");
      await checking;
      expect(f.check("grok").status).toBe("unknown");
      expect(f.checks().filter(check => check.tool === "grok")).toHaveLength(1);
      await owner.stop(f.engine);
      expect(alive(probe.pid)).toBe(false);
    } finally { held.release(); await owner.stop(f.engine); await checking; }
  });
});

/** Real review seats and readiness checks on the fake tool, without planning, building or voting. */
async function fixture(caseOwner: EngineCaseOwner, options: { pair?: boolean; seats?: string[]; checkTimeoutMs?: number; nativeProbe?: boolean } = {}) {
  const root = caseOwner.root;

  const { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name } = engineIn(caseOwner, root, options.checkTimeoutMs, options.nativeProbe);
  const { path: repo, initialSha: base } = await createProductRepository(root, { origin: "none" });
  fakes.scenario({ reopen: "resume" });
  engine.s.setup!.checks = engine.s.tools.map((tool) => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach((tool) => { tool.status = "ready"; });
  engine.s.pool.paused = false; engine.s.pool.limit = 3;
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "Recheck the saved seat", description: "ORIGINAL-SEAT-REQUEST", backlog: true });
  const task = engine.task(id)!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", baseSha: base, base: "main", savedVersion: readWorktreeCommit(repo), report: { summary: "First report", changes: [] } });
  const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: options.seats ?? (options.pair ? ["opus-high", "grok-high"] : ["opus-high"]) };
  task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] }; task.stageIndex = 0;
  task.brief = { summary: "UNCHANGED-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  const room = (toolId: string, profile: AgentProfile) => !slotWait(engine.activeState(), { ...profile, taskId: id, toolId });
  const choose = (seat = "0") => engine.choose(stage.profileIds[Number(seat)]!, scope, stage.roleId, room, seat)!;
  /** One review round of the seats not yet reported, as the driver runs it. */
  const round = async (number: number, signal = new AbortController().signal) => {
    task.rounds[stage.id] = number;
    task.hunt = { stageId: stage.id, round: number, reported: {} };
    await engine["reviews"]["hunt"](task, stage, stage.profileIds.map((profileId, index) => ({ key: String(index), profileId })), signal);
    endAgentStep(task, { outcome: "Reviewed", reason: "Controlled round completed" }, Date.now());
    engine.finishStep(scope);
    return task.journey!.at(-1)!.agentInputs!;
  };
  /** The live step already holds its one main place, last charged to the Builder that handed over. */
  const seated = () => Object.assign(task, { state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "sol-high", since: Date.now(), step: 0 } });
  const ours = () => slotUses(engine.activeState()).filter((use) => use.taskId === id);
  /** Another task already working, so the pool can be full. */
  const busy = (taskId: string, profileId: string) => {
    engine.s.tasks.push({ ...structuredClone(task), id: taskId, state: "running", holdsSlot: true, agent: { roleId: "builder", profileId, since: Date.now(), step: 0 }, journey: [], timeline: [] });
  };
  const release = (except: (session: string) => boolean = () => false) => {
    for (const entry of fakes.received()) if (!except(entry.session)) writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
  };
  return { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name, root, task, scope, stage, choose, round, seated, ours, busy, release };
}

describe.concurrent("a saved reviewer's uncertain tool", () => {
  for (const kind of ["stand-in", "planned"] as const) it(`rechecks the ${kind} seat's old uncertain answer once, keeping the step's place, then continues its conversation`, async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner);
    try {
      if (kind === "stand-in") f.engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 3_600_000, reason: "Controlled account limit" }];
      await f.round(1);
      f.engine.s.pool.limited = [];
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!["0"]!);
      expect(saved.profileId === "opus-high").toBe(kind === "planned");
      const previous = f.uncertain(saved.toolId);
      const held = f.holdCheck(saved.toolId);
      f.seated();
      const inputs = () => f.task.journey!.flatMap((step) => step.agentInputs ?? []).length;
      const before = inputs();
      const round = f.round(2);
      await held.reached();
      // Pending readiness is not an agent start: the place stays with the step, charged once to the saved tool.
      expect(f.task.statusLine).toBe(`Checking ${f.name[saved.toolId]} before returning to its saved conversation`);
      expect(f.task.holdsSlot).toBe(true);
      expect(f.task.agent).toEqual(expect.objectContaining({ roleId: "code-reviewer", profileId: saved.profileId }));
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: saved.toolId })]);
      const wait = f.task.reviewSessions![f.stage.id]!["0"]!.readinessWait!;
      expect(wait).toEqual({ at: expect.any(Number), toolId: saved.toolId, previous: { status: "unknown", at: previous.at }, check: "started" });
      expect(inputs()).toBe(before);
      expect(f.fakes.opens().filter((open) => open.session === saved.sessionId)).toHaveLength(1);
      // The wait is Petrina's own line: a restart never reports it as the reviewer's last activity.
      const line = f.task.timeline.find((entry) => entry.text.startsWith(`Checking ${f.name[saved.toolId]}`))!;
      expect(line).toEqual(expect.objectContaining({ tone: "status", text: `Checking ${f.name[saved.toolId]} before returning to its saved conversation (Code reviewer): ${f.name[saved.toolId]}'s last readiness check was inconclusive, so Petrina started one recheck` }));
      expect(line.roleId).toBeUndefined();
      expect(f.engine["turns"]["whereYouWere"](f.scope, f.engine.role("code-reviewer")!, 0).done.filter((text) => text.includes("readiness"))).toEqual([]);
      // Repeated selection only joins: no second check, no second admission.
      for (let i = 0; i < 3; i += 1) expect(f.choose()).toEqual(expect.objectContaining({ kind: "none", readiness: expect.objectContaining({ toolId: saved.toolId }) }));
      held.release();
      const [input] = await round;
      expect(f.checks().filter((entry) => entry.tool === saved.toolId)).toHaveLength(1);
      expect(f.check(saved.toolId).status).toBe("ready");
      expect(input).toEqual(expect.objectContaining({ mode: "continued", profileId: saved.profileId, requestedProfileId: "opus-high", sessionId: saved.sessionId }));
      expect(input!.readiness).toEqual({ ...wait, outcome: "ready" });
      expect(input!.selectionReason).toContain(`${f.name[saved.toolId]} passed its readiness recheck`);
      expect(f.fakes.opens().filter((open) => open.session === saved.sessionId).map((open) => open.how)).toEqual(["new", "resume"]);
    } finally { await caseOwner.stop(f.engine); }

  });
});

  it("falls back once, with the reason, when the recheck stays unanswered", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner, { checkTimeoutMs: 300 * SLOW, nativeProbe: true });
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!["0"]!);
      f.uncertain(saved.toolId);
      f.inChecks[saved.toolId] = ["--hang-in-checks"];
      f.seated();
      const [input] = await f.round(2);
      expect(input).toEqual(expect.objectContaining({ mode: "fresh", freshReason: "its saved tool's readiness recheck was inconclusive", taskDescription: "ORIGINAL-SEAT-REQUEST" }));
      expect(input!.readiness).toEqual(expect.objectContaining({ check: "started", outcome: "unknown", previous: expect.objectContaining({ status: "unknown" }) }));
      expect(input!.selectionReason).toStartWith("Started a fresh conversation: its saved tool's readiness recheck was inconclusive.");
      expect(f.engine.profile(input!.profileId)!.toolId).not.toBe(saved.toolId);
      expect(f.checks().filter((entry) => entry.tool === saved.toolId)).toHaveLength(1);
      expect(f.fakes.opens().filter((open) => open.session === saved.sessionId)).toHaveLength(1);
      await caseOwner.stop(f.engine);
      // The hung check was stopped with the engine.
      for (const { pid } of f.checks()) expect(alive(pid)).toBe(false);
    } finally { await caseOwner.stop(f.engine); }

  });
});

  it("never probes real login or install answers, and falls back when the recheck finds a logout", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner);
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!["0"]!);
      for (const status of ["logged-out", "not-installed"] as const) {
        Object.assign(f.check(saved.toolId), { status, at: Date.now() - OLD });
        expect(f.choose()).toEqual(expect.objectContaining({ freshReason: `its saved tool is ${status === "logged-out" ? "logged out" : "not installed"}` }));
      }
      // A recent uncertain answer follows the usual selection without a probe.
      Object.assign(f.check(saved.toolId), { status: "unknown", at: Date.now() - 60_000 });
      expect(f.choose()).toEqual(expect.objectContaining({ freshReason: "its saved tool's recent readiness check was inconclusive" }));
      expect(f.checks()).toHaveLength(0);
      f.uncertain(saved.toolId);
      f.inChecks[saved.toolId] = ["--logged-out-in-checks"];
      f.seated();
      const [input] = await f.round(2);
      expect(f.check(saved.toolId).status).toBe("logged-out");
      expect(input).toEqual(expect.objectContaining({ mode: "fresh", freshReason: "its saved tool is logged out" }));
      expect(input!.readiness).toEqual(expect.objectContaining({ check: "started", outcome: "logged-out" }));
      expect(f.checks()).toHaveLength(1);
    } finally { await caseOwner.stop(f.engine); }

  });
});


  it("shares one check per tool among competing seats, and joins one already running", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner);
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!["0"]!);
      f.uncertain(saved.toolId);
      const held = f.holdCheck(saved.toolId);
      const first = f.choose();
      if (first.kind !== "none" || !first.readiness) throw new Error("Expected a readiness decision");
      // Another task's saved Builder on the same tool asks at the same time.
      const other = { readinessWait: undefined as typeof saved.readinessWait };
      const second = { ...first.readiness, saved: other };
      const waits = Promise.all([f.engine.readiness.resolve(first.readiness), f.engine.readiness.resolve(second), f.engine.readiness.resolve(first.readiness)]);
      await held.reached();
      expect(other.readinessWait).toEqual(expect.objectContaining({ check: "joined" }));
      expect(f.task.reviewSessions![f.stage.id]!["0"]!.readinessWait).toEqual(expect.objectContaining({ check: "started" }));
      held.release();
      await waits;
      expect(f.checks().filter((entry) => entry.tool === saved.toolId)).toHaveLength(1);
      expect(f.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }), readiness: expect.objectContaining({ outcome: "ready" }) }));
      // An ordinary check already under way is joined rather than repeated.
      await engineCases.use("petrina-readiness-ordinary-check-", async laterOwner => {
      const later = await fixture(laterOwner);
      try {
        await later.round(1);
        const own = later.task.reviewSessions![later.stage.id]!["0"]!;
        later.uncertain(own.toolId);
        const ordinary = later.holdCheck(own.toolId);
        const checking = later.engine["tools"].check(own.toolId as CheckId);
        await ordinary.reached();
        const joined = later.choose();
        if (joined.kind !== "none" || !joined.readiness) throw new Error("Expected to join the running check");
        const waiting = later.engine.readiness.resolve(joined.readiness);
        expect(own.readinessWait).toEqual(expect.objectContaining({ check: "joined", previous: expect.objectContaining({ status: "unknown" }) }));
        ordinary.release();
        await Promise.all([checking, waiting]);
        expect(later.checks().filter((entry) => entry.tool === own.toolId)).toHaveLength(1);
        expect(later.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: own.profileId }) }));
      } finally { await laterOwner.stop(later.engine); }
      });
    } finally { await caseOwner.stop(f.engine); }

  });
});

  it("keeps the spent recheck through a restart without another probe, and leaves no check running", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner, { nativeProbe: true });
    let restarted: ReturnType<typeof engineIn> | undefined;
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!["0"]!);
      f.uncertain(saved.toolId);
      const held = f.holdCheck(saved.toolId);
      const first = f.choose();
      if (first.kind !== "none" || !first.readiness) throw new Error("Expected a readiness decision");
      const waiting = f.engine.readiness.resolve(first.readiness);
      await held.reached();
      const pid = f.checks()[0]!.pid;
      await caseOwner.stop(f.engine);
      await waiting;
      expect(alive(pid)).toBe(false);
      expect(f.engine["tools"].pending().checking).toHaveLength(0);
      expect(f.engine["tools"].pending().stopping).toHaveLength(0);
      restarted = engineIn(caseOwner, f.root, undefined, true);
      const task = restarted.engine.task(f.task.id)!;
      const wait = task.reviewSessions![f.stage.id]!["0"]!.readinessWait!;
      expect(wait).toEqual(expect.objectContaining({ check: "started", toolId: saved.toolId }));
      // Recovery released the place; the spent recheck is not renewed.
      expect(task.holdsSlot).toBe(false);
      const room = (toolId: string, profile: AgentProfile) => !slotWait(restarted!.engine.activeState(), { ...profile, taskId: task.id, toolId });
      const choose = () => restarted!.engine.choose("opus-high", executionFor(task), "code-reviewer", room, "0")!;
      expect(choose()).toEqual(expect.objectContaining({ kind: "none", readiness: expect.objectContaining({ toolId: saved.toolId }) }));
      // Its limit passes with no answer: the usual selection, without a second automatic probe.
      wait.at -= restarted.engine.readiness.limitMs();
      expect(choose()).toEqual(expect.objectContaining({ freshReason: "its saved tool did not answer its readiness recheck in time", readiness: expect.objectContaining({ outcome: "no answer" }) }));
      expect(restarted.checks()).toHaveLength(1);
      held.release();
    } finally {
      await caseOwner.stop(f.engine);
      await restarted?.engine.shutdown();
    }

  });
});
});

describe.concurrent("a review group's pending readiness decision", () => {
  /**
   * Round 1 on both planned seats. In round 2 the first reviewer starts fresh and works until released (the fake holds
   * only a conversation's first turn); the second returns to its saved Grok conversation, whose last answer is uncertain.
   */
  async function twoSeats(caseOwner: EngineCaseOwner, checkTimeoutMs?: number) {
    const f = await fixture(caseOwner, { pair: true, ...(checkTimeoutMs ? { checkTimeoutMs } : {}) });
    await f.round(1);
    const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
    expect(saved["1"]!.toolId).toBe("grok");
    delete f.task.reviewSessions![f.stage.id]!["0"];
    f.uncertain("grok");
    f.fakes.scenario({ reopen: "resume", controlled: true });
    f.seated();
    // Every change's places for this task, to see what it held between assertions.
    const seen: string[][] = [];
    f.engine.listeners.add(() => { seen.push(f.ours().map((use) => use.toolId).sort()); });
    return { f, saved, seen };
  }
  const firstOf = async (f: Awaited<ReturnType<typeof fixture>>, before: number) => (await waitFor(() => f.fakes.received().slice(before)[0], "the first reviewer's turn")).session;

  for (const how of ["held", "none"] as readonly string[]) it(`releases only an idle group's readiness reservation inside its real driver (${how})`, async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved } = await twoSeats(caseOwner);
    const held = f.holdCheck("grok");
    let drive: Promise<void> | undefined;
    try {
      f.task.startedAt = Date.now();
      f.task.rounds[f.stage.id] = 2;
      f.task.hunt = { stageId: f.stage.id, round: 2, reported: {} };
      f.task.plan!.stages.push({ id: "finished", title: "Review finished", kind: "gate", gate: "design", roleId: "coordinator", profileIds: [] });
      const product = f.engine.s.products[0]!;
      Object.assign(product, { defaultBranch: "main", remoteRefused: "Local delivery only", checks: [], checksBy: "coordinator" });
      // Keep the source identity on which round 1 saved its conversations.
      f.scope.work.delivery = "local";
      f.engine.s.pool.limit = 1;
      const prerequisite = f.engine.addTask({ productId: "p", title: "Finish the required source", backlog: true });
      const before = f.fakes.received().length;
      f.engine.startDriver(f.task.id);
      drive = f.engine.settling.get(f.task.id)!;
      const first = await firstOf(f, before);
      writeFileSync(join(f.fakes.dir, `release-${first}`), "go");
      await waitFor(() => f.checks().length || f.task.state === "failed" || !f.engine.drivers.has(f.task.id) || f.fakes.received().length > before + 1, "readiness to start after the first reviewer finishes");
      expect(f.task.error).toBeUndefined();
      expect(f.engine.drivers.has(f.task.id)).toBe(true);
      expect(f.checks()).toHaveLength(1);
      await held.reached();
      await waitFor(() => f.task.hunt?.reported["0"] && f.task.agent?.reviewKey === "reviewer:1" || f.task.state === "failed" || !f.engine.drivers.has(f.task.id), "the idle group to retain its returning peer's reservation");
      expect(f.task.error).toBeUndefined();
      expect(f.engine.drivers.has(f.task.id)).toBe(true);
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: "grok" })]);
      const queued = f.engine.addTask({ productId: "p", title: "Use the group's freed place" });
      f.engine["driver"].schedule();
      expect(f.engine.task(queued)!.state).toBe("queued");
      if (how !== "none") {
        f.engine.setRuntimeWait(f.task.id, [prerequisite], "Finish the required source before new review work", "hold-idle-group");
        f.engine["driver"].syncRuntimeWaits();
        // The live driver is still registered: the readiness owner itself must release its idle place.
        expect(f.ours()).toEqual([]);
        expect(f.task.state).toBe("waiting");
        expect(f.task.agent).toBeUndefined();
        expect(f.engine["tools"].running("grok")).toBeDefined();
        await drive;
        f.engine["driver"].schedule();
        await waitFor(() => f.fakes.received("planner").length === 1, "queued work to use the idle group's place before readiness replies");
        expect(slotUses(f.engine.activeState()).map(use => use.taskId)).toEqual([queued]);
        if (how === "clear") f.engine.setRuntimeWait(f.task.id, [], "The coordinator approved finishing the review", "clear-idle-group");
        else if (how === "landed") {
          const required = f.engine.task(prerequisite)!;
          required.repository!.delivery = "local";
          required.repository!.landed = { branch: "main", sha: f.scope.work.baseSha! };
          required.state = "done";
          f.engine["driver"].syncRuntimeWaits();
        }
      }
      held.release();
      await waitFor(() => f.check("grok").status === "ready" && !f.engine["tools"].running("grok"), "the shared readiness reply");
      if (how === "none") {
        await drive;
        expect(f.task.stageIndex).toBe(1);
        expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new", "resume"]);
      } else {
        f.engine["driver"].schedule();
        // A late answer is not a fresh reservation: queued work still owns the only place.
        expect(f.ours()).toEqual([]);
        expect(f.task.hunt?.reported).toEqual({ "0": true });
        expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new"]);
        if (how === "held") f.engine.setRuntimeWait(f.task.id, [], "The coordinator approved finishing the review", "clear-idle-group");
        f.engine.pause(queued);
        await waitFor(() => !f.engine.drivers.has(queued) && !f.engine.settling.has(queued), "queued work to finish its pause cleanup");
        f.engine["driver"].schedule();
        await waitFor(() => f.task.stageIndex === 1 && !f.engine.drivers.has(f.task.id) && !f.engine.settling.has(f.task.id), "only the missing reviewer to finish through normal admission");
        expect(f.task.error).toBeUndefined();
        expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new", "resume"]);
        expect(f.task.rounds[f.stage.id]).toBe(2);
        expect(f.task.journey!.filter(step => step.roleId === "code-reviewer").at(-1)!.agentResults).toHaveLength(2);
        expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
      }
      expect(f.checks()).toHaveLength(1);
      expect(f.fakes.received().filter(entry => entry.session === first)).toHaveLength(1);
    } finally { held.release(); f.release(); await caseOwner.stop(f.engine); await drive; }

  });
});

  it("keeps an actually working peer's place when a hold interrupts the group's readiness decision", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved } = await twoSeats(caseOwner);
    const held = f.holdCheck("grok");
    let drive: Promise<void> | undefined;
    try {
      f.task.startedAt = Date.now();
      f.task.rounds[f.stage.id] = 2;
      f.task.hunt = { stageId: f.stage.id, round: 2, reported: {} };
      f.engine.s.pool.limit = 2;
      const prerequisite = f.engine.addTask({ productId: "p", title: "Finish the required source", backlog: true });
      const before = f.fakes.received().length;
      f.engine.startDriver(f.task.id); drive = f.engine.settling.get(f.task.id)!;
      const first = await firstOf(f, before);
      await held.reached();
      f.engine.setRuntimeWait(f.task.id, [prerequisite], "No new peer until the required fix lands", "hold-working-group");
      f.engine["driver"].syncRuntimeWaits();
      expect(f.engine.drivers.has(f.task.id)).toBe(true);
      expect(f.task.state).toBe("running");
      expect(f.task.holdsSlot).toBe(true);
      expect(f.task.agent?.reviewKey).toBe("reviewer:0");
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: "claude-code" })]);
      expect(f.engine["tools"].running("grok")).toBeDefined();
      const queued = f.engine.addTask({ productId: "p", title: "Use only the place that is free" });
      f.engine["driver"].schedule();
      await waitFor(() => f.fakes.received("planner").length === 1, "queued work beside the admitted peer");
      expect(slotUses(f.engine.activeState()).map(use => use.taskId).sort()).toEqual([f.task.id, queued].sort());
      held.release();
      await waitFor(() => f.check("grok").status === "ready", "the shared readiness answer beside the working peer");
      expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new"]);
      writeFileSync(join(f.fakes.dir, `release-${first}`), "go");
      await drive;
      expect(f.task.state).toBe("waiting");
      expect(f.task.hunt?.reported).toEqual({ "0": true });
      expect(f.ours()).toEqual([]);
      expect(slotUses(f.engine.activeState()).map(use => use.taskId)).toEqual([queued]);
      expect(f.task.rounds[f.stage.id]).toBe(2);
      expect(f.checks()).toHaveLength(1);
    } finally { held.release(); f.release(); await caseOwner.stop(f.engine); await drive; }

  });
});

  it("rechecks the second reviewer while the first works, adding no place until it reopens", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved, seen } = await twoSeats(caseOwner);
    try {
      const held = f.holdCheck("grok");
      const before = f.fakes.received().length;
      const round = f.round(2);
      await firstOf(f, before);
      await held.reached();
      expect(f.task.reviewSessions![f.stage.id]!["1"]!.readinessWait).toEqual(expect.objectContaining({ check: "started" }));
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: "claude-code" })]);
      expect(f.task.agent).toEqual(expect.objectContaining({ reviewKey: "reviewer:0" }));
      held.release();
      // The reopened reviewer works beside the first in a place of its own, and gives it back when it finishes.
      await waitFor(() => f.task.journey!.at(-1)!.agentResults?.length === 1, "the reopened reviewer's report");
      await waitFor(() => f.ours().length === 1 && f.task.helpers === undefined, "the finished reviewer's helper place to be released");
      expect(seen).toContainEqual(["claude-code", "grok"]);
      f.release();
      const inputs = await round;
      const second = inputs.find((input) => input.reviewerKey === "1")!;
      expect(second).toEqual(expect.objectContaining({ mode: "continued", sessionId: saved["1"]!.sessionId, readiness: expect.objectContaining({ outcome: "ready" }) }));
      const results = f.task.journey!.flatMap((step) => step.agentResults ?? []).filter((result) => result.at >= second.at!);
      expect(results.map((result) => result.profileId)).toEqual([saved["1"]!.profileId, "opus-high"]);
      expect(f.checks()).toHaveLength(1);
    } finally { f.release(); await caseOwner.stop(f.engine); }

  });
});

  it("frees the group's place after admitted reviewers finish under a prerequisite wait, then resumes only the missing seat", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved } = await twoSeats(caseOwner);
    const held = f.holdCheck("grok");
    try {
      f.task.startedAt = Date.now();
      const prerequisite = f.engine.addTask({ productId: "p", title: "Fix the capacity tests", backlog: true });
      const before = f.fakes.received().length;
      const round = f.round(2);
      const interrupted = rejectionOf(round);
      const first = await firstOf(f, before);
      await held.reached();
      f.engine.setRuntimeWait(f.task.id, [prerequisite], "The final validation needs the capacity fix", "hold-review");
      // This private hunt skips scheduling; the public wait command records admitted work there.
      f.engine["driver"].syncRuntimeWaits();
      writeFileSync(join(f.fakes.dir, `release-${first}`), "go");
      await waitFor(() => f.task.hunt?.reported["0"] && !f.task.holdsSlot, "the admitted reviewer's report and released place");
      expect(f.task.state).toBe("waiting");
      expect(f.task.statusLine).toBe("Waiting for “Fix the capacity tests” to land");
      expect(f.task.agent).toBeUndefined();
      expect(f.task.helpers).toBeUndefined();
      expect(f.ours()).toEqual([]);
      const step = f.task.journey!.at(-1)!;
      const stepId = step.id;
      expect(step.endedAt).toBeUndefined();
      expect(step.agentResults).toHaveLength(1);
      expect(step.agentInputs?.map(input => input.reviewerKey)).toEqual(["0"]);
      expect(f.task.rounds[f.stage.id]).toBe(2);
      // The admitted tool check finishes, but its answer admits no new reviewer while the task waits.
      held.release();
      expect(await interrupted).toBeInstanceOf(WaitingForUsage);
      await waitFor(() => f.check("grok").status === "ready", "the shared readiness answer after the group released its place");
      expect(f.check("grok").status).toBe("ready");
      expect(f.task.hunt?.reported).toEqual({ "0": true });
      expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new"]);
      f.engine.setRuntimeWait(f.task.id, [], "The coordinator approved finishing this review", "clear-review");
      f.seated();
      await f.engine["reviews"]["hunt"](f.task, f.stage, [{ key: "1", profileId: "grok-high" }], new AbortController().signal);
      const resumed = f.task.journey!.at(-1)!;
      expect(resumed.id).toBe(stepId);
      expect(resumed.agentResults).toHaveLength(2);
      expect(resumed.agentInputs?.map(input => input.reviewerKey)).toEqual(["0", "1"]);
      expect(resumed.agentInputs?.find(input => input.reviewerKey === "1")).toEqual(expect.objectContaining({ mode: "continued", sessionId: saved["1"]!.sessionId }));
      expect(f.task.hunt?.reported).toEqual({ "0": true, "1": true });
      expect(f.task.rounds[f.stage.id]).toBe(2);
      expect(f.checks()).toHaveLength(1);
      expect(f.fakes.received().filter(entry => entry.session === first)).toHaveLength(1);
      expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new", "resume"]);
    } finally { held.release(); f.release(); await caseOwner.stop(f.engine); }

  });
});


  for (const when of ["after"] as readonly string[]) it(`keeps one main place, charged to the waiting reviewer's tool, when the last working reviewer finishes ${when} the check starts`, async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved, seen } = await twoSeats(caseOwner);
    try {
      // A full pool: another task works, and queued work would take any place the group lets go.
      f.engine.s.pool.limit = when === "after" ? 2 : 3;
      f.busy("other", "sol-high");
      const held = f.holdCheck("grok");
      const before = f.fakes.received().length;
      const round = f.round(2);
      const first = await firstOf(f, before);
      if (when === "before") {
        await held.reached();
        f.busy("queued-work", "astra-xhigh");
      } else expect(existsSync(join(f.fakes.dir, "checks.jsonl"))).toBe(false);
      writeFileSync(join(f.fakes.dir, `release-${first}`), "go");
      await held.reached();
      await waitFor(() => f.task.agent?.reviewKey === "reviewer:1", "the waiting reviewer to hold the group's place");
      expect(f.task.statusLine).toBe("Checking Grok before returning to its saved conversation");
      expect(f.task.holdsSlot).toBe(true);
      expect(f.task.helpers).toBeUndefined();
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: "grok", profileId: saved["1"]!.profileId })]);
      expect(slotWait(f.engine.activeState(), { taskId: "next-in-queue", toolId: "codex" })).toBe("Waiting for a free slot");
      const since = seen.length;
      held.release();
      const second = (await round).find((input) => input.reviewerKey === "1")!;
      expect(second).toEqual(expect.objectContaining({ mode: "continued", sessionId: saved["1"]!.sessionId, readiness: expect.objectContaining({ outcome: "ready" }) }));
      // It continued in that same place: never a second one, never released to queued work in between.
      expect(seen.slice(since).filter((uses) => uses.length)).not.toHaveLength(0);
      expect(seen.slice(since).every((uses) => uses.length <= 1 && uses.every((tool) => tool === "grok"))).toBe(true);
    } finally { f.release(); await caseOwner.stop(f.engine); }

  });
});

  it("rechecks a reviewer set aside by a full model while its peer works, then brings it back to its saved conversation", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    // Two Codex seats share one planned profile; the other tools are out, so the review stays on Claude Code and Codex.
    const f = await fixture(caseOwner, { seats: ["opus-high", "sol-high", "sol-high"] });
    try {
      for (const toolId of ["grok", "antigravity"]) {
        Object.assign(f.check(toolId), { status: "logged-out" });
        f.engine.s.tools.find((tool) => tool.id === toolId)!.status = "logged-out";
      }
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
      expect(saved["2"]!.toolId).toBe("codex");
      delete f.task.reviewSessions![f.stage.id]!["0"];
      delete f.task.reviewSessions![f.stage.id]!["1"];
      // The second Codex seat's own conversation already used its full-model stop; only the first seat's new one stops.
      writeFileSync(join(f.fakes.dir, `capacity-${saved["2"]!.sessionId}.json`), JSON.stringify({ used: 1, armed: true }));
      f.fakes.scenario({ reopen: "resume", controlled: true, capacity: [{ model: "gpt-6.1-sol", role: "code reviewer", times: 1 }] });
      // Two places: the held Opus reviewer and one Codex seat.
      f.engine.s.pool.limit = 2;
      f.seated();
      const before = f.fakes.received().length;
      const round = f.round(2);
      const opus = await waitFor(() => f.fakes.received().slice(before).find((entry) => f.fakes.settings(entry.session).includes("model=opus"))?.session, "the held Opus reviewer");
      const group = f.engine.screenGroups.get(f.task.id)!;
      // The first Codex seat stops on the full model; the second, next in line, waits on that model's short retry too.
      await waitFor(() => f.task.capacityRetries?.some((entry) => entry.member === "review-1") && !group.running("review-1"), "the first Codex seat to wait out its model");
      expect(group.running("review-2")).toBe(false);
      const held = f.holdCheck("codex");
      f.uncertain("codex");
      // With Codex uncertain, the first seat comes back on another tool: give it a place of its own beside the held peer.
      f.engine.s.pool.limit = 3;
      for (const entry of f.task.modelCapacity ?? []) entry.until = Date.now() - 1;
      // The scheduling pass that runs when the wait ends starts the saved seat's recheck at once, beside the working peer.
      f.engine["driver"].schedule();
      expect(f.task.reviewSessions![f.stage.id]!["2"]!.readinessWait).toEqual(expect.objectContaining({ check: "started" }));
      await held.reached();
      expect(group.running("review-2")).toBe(false);
      held.release();
      await waitFor(() => f.check("codex").status === "ready" && !f.engine["tools"].running("codex"), "the readiness answer");
      // The answer's own scheduling pass brings it back, while the Opus reviewer is still held.
      await waitFor(() => { f.engine["driver"].schedule(); return f.task.hunt?.reported["2"]; }, "the saved Codex seat to come back and report");
      expect(f.task.hunt?.reported["0"]).toBeUndefined();
      expect(existsSync(join(f.fakes.dir, `release-${opus}`))).toBe(false);
      f.release();
      const inputs = await round;
      const second = inputs.findLast((input) => input.reviewerKey === "2")!;
      expect(second).toEqual(expect.objectContaining({ mode: "continued", sessionId: saved["2"]!.sessionId, readiness: expect.objectContaining({ outcome: "ready" }) }));
      expect(f.checks().filter((entry) => entry.tool === "codex")).toHaveLength(1);
    } finally { f.release(); await caseOwner.stop(f.engine); }

  });
});


  it("ends the decision on cancellation, so a late answer starts nobody", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const { f, saved } = await twoSeats(caseOwner);
    try {
      const held = f.holdCheck("grok");
      const stop = new AbortController();
      const before = f.fakes.received().length;
      const round = f.round(2, stop.signal);
      await firstOf(f, before);
      await held.reached();
      stop.abort();
      f.engine.cancel(f.task.id);
      await round.catch(() => undefined);
      held.release();
      await waitFor(() => f.check("grok").status === "ready", "the late readiness answer");
      expect(f.fakes.opens().filter((open) => open.session === saved["1"]!.sessionId)).toHaveLength(1);
      expect(f.task.holdsSlot).toBe(false);
    } finally { f.release(); await caseOwner.stop(f.engine); }

  });
});
});

describe.concurrent("a returning Builder's uncertain tool", () => {
  it("keeps the spent recheck with a reopened Builder through another interruption, so a later uncertain answer gets no second check", async () => {
  return engineCases.use("petrina-readiness-recheck-", async caseOwner => {
    const f = await fixture(caseOwner);
    try {
      f.task.plan = { rationale: "Build", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] }] };
      f.task.stageIndex = 0;
      // The Builder keeps working until its second restart, so it can be interrupted twice before it finishes.
      f.fakes.scenario({ reopen: "resume", builder: "work", restarts: 2 });
      const build = (signal: AbortSignal) => f.engine["turns"].turn(f.scope, "builder", "opus-high", () => [], BuildResult, signal);
      // Interrupted once its working turn is recorded: the fake marks itself working, and the engine heard the step.
      const interrupt = async (working: string) => {
        const stop = new AbortController();
        const turn = build(stop.signal);
        await waitFor(() => f.fakes.marked(working) && f.scope.work.conversation?.briefed, `the Builder at work (${working})`);
        stop.abort();
        await rejectionOf(turn);
      };
      await interrupt("builder-working");
      const saved = f.scope.work.conversation!;
      expect(saved.briefed).toBe(true);
      // Its tool's last answer was Couldn't check, ten minutes ago: one recheck passes and the same conversation reopens.
      f.uncertain("claude-code");
      const held = f.holdCheck("claude-code");
      f.seated();
      const reopening = interrupt("builder-restart-1");
      await held.reached();
      const wait = structuredClone(saved.readinessWait!);
      expect(wait).toEqual(expect.objectContaining({ toolId: "claude-code", check: "started", previous: expect.objectContaining({ status: "unknown" }) }));
      held.release();
      await reopening;
      const reopened = f.scope.work.conversation!;
      expect(reopened.sessionId).toBe(saved.sessionId);
      expect(f.fakes.opens().filter((open) => open.session === saved.sessionId).map((open) => open.how)).toEqual(["new", "resume"]);
      // Interrupted again before it finishes: the reopened conversation still carries the spent recheck.
      expect(reopened.readinessWait).toEqual(wait);
      // A later ordinary answer is Couldn't check, and the clock moves on ten minutes before scheduling chooses again.
      Object.assign(f.check("claude-code"), { status: "unknown", at: Date.now() });
      reopened.readinessWait!.at -= OLD;
      f.check("claude-code").at! -= OLD;
      Object.assign(f.task, { state: "waiting", holdsSlot: false });
      delete f.task.agent;
      const choice = f.engine.choose("opus-high", f.task, "builder", () => true);
      expect(choice).toEqual(expect.objectContaining({ freshReason: "its saved tool's readiness recheck was inconclusive", readiness: expect.objectContaining({ check: "started", outcome: "unknown" }) }));
      expect(choice?.kind === "none" ? undefined : choice?.profile.toolId).not.toBe("claude-code");
      f.engine["driver"].workflow["reserveAgent"](f.task);
      expect(f.checks().filter((entry) => entry.tool === "claude-code")).toHaveLength(1);
    } finally { await caseOwner.stop(f.engine); }

  });
});


});
