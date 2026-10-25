import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endAgentStep, slotUses, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { Aborted } from "../../../src/kernel.js";
import { WaitingForUsage } from "../../../src/usage.js";
import { BuildResult } from "../../../src/roles.js";
import { Fakes, git, makeProduct, removeDir, SLOW, tempDir, waitFor } from "../../fixtures.js";
import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const OLD = 10 * 60_000;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** An engine whose agents and readiness checks run the fake tool in `root`, keeping its data there across restarts. */
function engineIn(root: string, checkTimeoutMs = 8_000 * SLOW) {
  const fakes = new Fakes(join(root, "fake"));
  // Flags each tool's next readiness check gets; agent turns ignore them.
  const inChecks: Record<string, string[]> = {};
  const engine = new Engine(join(root, "data"), {
    agentCommand: (profile) => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`, ...(inChecks[profile.toolId] ?? [])],
    toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
    toolCheckTimeoutMs: checkTimeoutMs,
  });
  engine.schedule = () => {};
  const name = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok" } as Record<string, string>;
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
    return { reached: () => waitFor(() => existsSync(`${file}.reached`), `${toolId}'s held readiness check`), release: () => rmSync(file, { force: true }) };
  };
  return { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name };
}

/** Real review seats and readiness checks on the fake tool, without planning, building or voting. */
async function fixture(options: { pair?: boolean; seats?: string[]; checkTimeoutMs?: number } = {}) {
  const root = tempDir("petrina-readiness-recheck-");
  roots.push(root);
  const { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name } = engineIn(root, options.checkTimeoutMs);
  const repo = await makeProduct(root), base = await git(repo, "rev-parse", "HEAD");
  fakes.scenario({ reopen: "resume" });
  engine.s.setup!.checks = engine.s.tools.map((tool) => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach((tool) => { tool.status = "ready"; });
  engine.s.pool.paused = false; engine.s.pool.limit = 3;
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "Recheck the saved seat", description: "ORIGINAL-SEAT-REQUEST", backlog: true });
  const task = engine.task(id)!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", baseSha: base, base: "main", report: { summary: "First report", changes: [] } });
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
    const f = await fixture();
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
    } finally { await f.engine.shutdown(); }
  });

  it("falls back once, with the reason, when the recheck stays unanswered", async () => {
    const f = await fixture({ checkTimeoutMs: 300 * SLOW });
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
      await f.engine.shutdown();
      // The hung check was stopped with the engine.
      for (const { pid } of f.checks()) expect(alive(pid)).toBe(false);
    } finally { await f.engine.shutdown(); }
  });

  it("never probes real login or install answers, and falls back when the recheck finds a logout", async () => {
    const f = await fixture();
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
    } finally { await f.engine.shutdown(); }
  });

  it("never probes to overcome another restriction, such as a peer now on the saved tool", async () => {
    const f = await fixture({ pair: true });
    try {
      await f.round(1);
      f.uncertain("grok");
      // The first seat reported on Grok this round: the second seat's saved Grok conversation is no longer independent.
      f.task.rounds[f.stage.id] = 2;
      f.task.hunt = { stageId: f.stage.id, round: 2, reported: { "0": true }, profiles: { "0": "grok-high" } };
      const choice = f.choose("1");
      expect(choice).toEqual(expect.objectContaining({ freshReason: expect.stringContaining("independent") }));
      expect(choice.kind === "none" ? undefined : f.engine.profile(choice.profile.id)!.toolId).not.toBe("grok");
      expect(f.task.reviewSessions![f.stage.id]!["1"]!.readinessWait).toBeUndefined();
      expect(f.checks()).toHaveLength(0);
    } finally { await f.engine.shutdown(); }
  });

  it("shares one check per tool among competing seats, and joins one already running", async () => {
    const f = await fixture();
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
      const later = await fixture();
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
      } finally { await later.engine.shutdown(); }
    } finally { await f.engine.shutdown(); }
  });

  it("keeps the spent recheck through a restart without another probe, and leaves no check running", async () => {
    const f = await fixture();
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
      await f.engine.shutdown();
      await waiting;
      expect(alive(pid)).toBe(false);
      expect(f.engine["tools"].pending().checking).toHaveLength(0);
      expect(f.engine["tools"].pending().stopping).toHaveLength(0);
      restarted = engineIn(f.root);
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
      await f.engine.shutdown();
      await restarted?.engine.shutdown();
    }
  });
});

describe.concurrent("a review group's pending readiness decision", () => {
  /**
   * Round 1 on both planned seats. In round 2 the first reviewer starts fresh and works until released (the fake holds
   * only a conversation's first turn); the second returns to its saved Grok conversation, whose last answer is uncertain.
   */
  async function twoSeats(checkTimeoutMs?: number) {
    const f = await fixture({ pair: true, ...(checkTimeoutMs ? { checkTimeoutMs } : {}) });
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

  for (const how of ["held", "clear", "landed", "none"] as const) it(`releases only an idle group's readiness reservation inside its real driver (${how})`, async () => {
    const { f, saved } = await twoSeats();
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
    } finally { held.release(); f.release(); await f.engine.shutdown(); await drive; }
  });

  it("keeps an actually working peer's place when a hold interrupts the group's readiness decision", async () => {
    const { f, saved } = await twoSeats();
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
    } finally { held.release(); f.release(); await f.engine.shutdown(); await drive; }
  });

  it("rechecks the second reviewer while the first works, adding no place until it reopens", async () => {
    const { f, saved, seen } = await twoSeats();
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
    } finally { f.release(); await f.engine.shutdown(); }
  });

  it("frees the group's place after admitted reviewers finish under a prerequisite wait, then resumes only the missing seat", async () => {
    const { f, saved } = await twoSeats();
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
    } finally { held.release(); f.release(); await f.engine.shutdown(); }
  });

  it("starts no readiness probe or reviewer when a prerequisite wait already holds the group", async () => {
    const { f, saved } = await twoSeats();
    try {
      f.task.startedAt = Date.now();
      const prerequisite = f.engine.addTask({ productId: "p", title: "Finish the required fix", backlog: true });
      const before = f.fakes.received().length;
      f.engine.setRuntimeWait(f.task.id, [prerequisite], "The required fix must land first", "hold-before-review");
      expect(await rejectionOf(f.round(2))).toBeInstanceOf(WaitingForUsage);
      expect(f.checks()).toEqual([]);
      expect(f.fakes.received()).toHaveLength(before);
      expect(f.task.reviewSessions![f.stage.id]!["1"]!.readinessWait).toBeUndefined();
      expect(f.fakes.opens().filter(open => open.session === saved["1"]!.sessionId).map(open => open.how)).toEqual(["new"]);
      expect(f.task.holdsSlot).toBe(false);
      expect(f.task.state).toBe("waiting");
      expect(f.task.statusLine).toBe("Waiting for “Finish the required fix” to land");
    } finally { f.release(); await f.engine.shutdown(); }
  });

  for (const when of ["after", "before"] as const) it(`keeps one main place, charged to the waiting reviewer's tool, when the last working reviewer finishes ${when} the check starts`, async () => {
    const { f, saved, seen } = await twoSeats();
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
    } finally { f.release(); await f.engine.shutdown(); }
  });

  it("rechecks a reviewer set aside by a full model while its peer works, then brings it back to its saved conversation", async () => {
    // Two Codex seats share one planned profile; the other tools are out, so the review stays on Claude Code and Codex.
    const f = await fixture({ seats: ["opus-high", "sol-high", "sol-high"] });
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
    } finally { f.release(); await f.engine.shutdown(); }
  });

  it("lets the place go when the decision ends with no reviewer able to use it", async () => {
    const { f } = await twoSeats();
    try {
      const held = f.holdCheck("grok");
      const before = f.fakes.received().length;
      const round = f.round(2);
      writeFileSync(join(f.fakes.dir, `release-${await firstOf(f, before)}`), "go");
      await held.reached();
      await waitFor(() => f.task.agent?.reviewKey === "reviewer:1", "the waiting reviewer to hold the group's place");
      // Every other tool runs out meanwhile, then the recheck ends without an answer: nobody can take the seat.
      f.engine.s.pool.limited = ["claude-code", "codex", "antigravity"].map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: "Controlled usage limit" }));
      process.kill(f.checks()[0]!.pid, "SIGKILL");
      expect(await rejectionOf(round)).toBeInstanceOf(WaitingForUsage);
      expect(f.check("grok").status).toBe("unknown");
      expect(f.task.statusLine).toStartWith("Waiting for usage");
      expect(f.task.holdsSlot).toBe(false);
      expect(f.task.agent).toBeUndefined();
      expect(f.task.state).toBe("waiting");
      expect(f.checks().filter((entry) => entry.tool === "grok")).toHaveLength(1);
      held.release();
    } finally { f.release(); await f.engine.shutdown(); }
  });

  it("ends the decision on cancellation, so a late answer starts nobody", async () => {
    const { f, saved } = await twoSeats();
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
    } finally { f.release(); await f.engine.shutdown(); }
  });
});

describe.concurrent("a returning Builder's uncertain tool", () => {
  /** A fix round whose Builder saved its Codex conversation; the reviewer's place on Claude Code is still held. */
  async function fixRound() {
    const f = await fixture();
    f.task.plan = { rationale: "Build and review", plannerProfileId: "sol-high", stages: [
      { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
      f.stage,
    ] };
    Object.assign(f.task, { stageIndex: 0, fixing: true, state: "running", holdsSlot: true, agent: { roleId: "code-reviewer", profileId: "opus-high", since: Date.now(), step: 0 } });
    f.scope.work.builderSession = { stageId: "build", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "saved-builder" };
    f.scope.work.delivery = "local";
    f.engine.s.pool.limit = 2;
    f.busy("other", "grok-high");
    f.uncertain("codex");
    return f;
  }

  it("starts no readiness probe for a returning Builder under a prerequisite wait", async () => {
    const f = await fixRound();
    const held = f.holdCheck("codex");
    try {
      f.task.startedAt = Date.now();
      const prerequisite = f.engine.addTask({ productId: "p", title: "Fix the capacity tests", backlog: true });
      const saved = structuredClone(f.scope.work.builderSession!);
      f.engine.setRuntimeWait(f.task.id, [prerequisite], "The final validation needs the capacity fix", "hold-before-builder");
      expect(f.engine["driver"]["reserveAgent"](f.task)).toBe(false);
      expect(await f.engine["driver"]["admitNext"](f.task, new AbortController().signal)).toBe(false);
      expect(f.checks()).toEqual([]);
      expect(f.scope.work.builderSession!.readinessWait).toBeUndefined();
      expect(f.task.state).toBe("waiting");
      expect(f.task.statusLine).toBe("Waiting for “Fix the capacity tests” to land");
      expect(f.ours()).toEqual([]);
      f.engine.setRuntimeWait(f.task.id, [], "The coordinator approved continuing", "clear-before-builder");
      await f.engine["driver"]["refreshAfterWait"](f.task, new AbortController().signal);
      f.seated();
      const admitted = f.engine["driver"]["admitNext"](f.task, new AbortController().signal);
      await held.reached();
      held.release();
      expect(await admitted).toBe(true);
      expect(f.task.agent).toEqual(expect.objectContaining({ roleId: "builder", profileId: saved.profileId }));
      expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
      expect(f.engine.choose("opus-high", f.task, "builder", () => true)).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }), readiness: expect.objectContaining({ outcome: "ready" }) }));
      expect(f.checks()).toHaveLength(1);
    } finally { held.release(); await f.engine.shutdown(); }
  });

  it("releases a returning Builder's unused place when a prerequisite wait interrupts readiness", async () => {
    const f = await fixRound();
    const held = f.holdCheck("codex");
    try {
      f.task.startedAt = Date.now();
      const prerequisite = f.engine.addTask({ productId: "p", title: "Fix the capacity tests", backlog: true });
      const saved = structuredClone(f.scope.work.builderSession!);
      const admitted = f.engine["driver"]["admitNext"](f.task, new AbortController().signal);
      await held.reached();
      const wait = structuredClone(f.scope.work.builderSession!.readinessWait!);
      f.engine.setRuntimeWait(f.task.id, [prerequisite], "The final validation needs the capacity fix", "hold-during-builder-check");
      f.engine["driver"].syncRuntimeWaits();
      expect(await admitted).toBe(false);
      expect(f.task.state).toBe("waiting");
      expect(f.task.statusLine).toBe("Waiting for “Fix the capacity tests” to land");
      expect(f.ours()).toEqual([]);
      expect(f.fakes.received()).toEqual([]);
      expect(f.scope.work.builderSession!.readinessWait).toEqual(wait);
      expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
      expect(f.ours()).toEqual([]);
      expect(f.engine["tools"].running("codex")).toBeDefined();
      held.release();
      await waitFor(() => f.check("codex").status === "ready", "the shared readiness answer after the place was released");
      f.engine.setRuntimeWait(f.task.id, [], "The coordinator approved continuing", "clear-after-builder-check");
      await f.engine["driver"]["refreshAfterWait"](f.task, new AbortController().signal);
      expect(await f.engine["driver"]["admitNext"](f.task, new AbortController().signal)).toBe(true);
      expect(f.task.agent).toEqual(expect.objectContaining({ roleId: "builder", profileId: saved.profileId }));
      expect(f.scope.work.builderSession!.readinessWait).toEqual(wait);
      expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
      expect(f.checks()).toHaveLength(1);
    } finally { held.release(); await f.engine.shutdown(); }
  });

  it("keeps the spent recheck with a reopened Builder through another interruption, so a later uncertain answer gets no second check", async () => {
    const f = await fixture();
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
      f.engine["driver"]["reserveAgent"](f.task);
      expect(f.checks().filter((entry) => entry.tool === "claude-code")).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps the step's place for the recheck, moves its charge to the saved tool, and continues there", async () => {
    const f = await fixRound();
    try {
      const held = f.holdCheck("codex");
      const admitted = f.engine["driver"]["admitNext"](f.task, new AbortController().signal);
      await held.reached();
      expect(f.task.statusLine).toBe("Checking Codex before the Builder returns");
      expect(f.ours()).toEqual([expect.objectContaining({ toolId: "codex", roleId: "builder", profileId: "sol-high" })]);
      expect(slotWait(f.engine.activeState(), { taskId: "next-in-queue", toolId: "claude-code" })).toBe("Waiting for a free slot");
      held.release();
      expect(await admitted).toBe(true);
      expect(f.task.agent).toEqual(expect.objectContaining({ roleId: "builder", profileId: "sol-high" }));
      expect(f.engine.choose("opus-high", f.task, "builder", () => true)).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: "sol-high" }), readiness: expect.objectContaining({ outcome: "ready", check: "started" }) }));
    } finally { await f.engine.shutdown(); }
  });

  it("checks admission again when the decision settles, so a cap lowered meanwhile still applies", async () => {
    const f = await fixRound();
    try {
      const held = f.holdCheck("codex");
      const admitted = f.engine["driver"]["admitNext"](f.task, new AbortController().signal);
      await held.reached();
      f.engine.s.pool.toolCaps["codex"] = 0;
      held.release();
      expect(await admitted).toBe(true);
      expect(f.check("codex").status).toBe("ready");
      expect(f.engine.profile(f.task.agent!.profileId)!.toolId).not.toBe("codex");
      expect(f.ours()).toEqual([expect.objectContaining({ roleId: "builder" })]);
    } finally { await f.engine.shutdown(); }
  });

  it("acquires no place for a task already waiting, and stops waiting in place when paused", async () => {
    const f = await fixRound();
    try {
      const held = f.holdCheck("codex");
      Object.assign(f.task, { state: "waiting", holdsSlot: false });
      delete f.task.agent;
      expect(f.engine["driver"]["reserveAgent"](f.task)).toBe(false);
      await held.reached();
      expect(f.task.holdsSlot).toBe(false);
      expect(f.task.statusLine).toBe("Checking Codex before the Builder returns");
      expect(f.scope.work.builderSession!.readinessWait).toEqual(expect.objectContaining({ check: "started" }));
      // The same task now holding its place waits there; pausing ends that wait and the place.
      Object.assign(f.task, { state: "running", holdsSlot: true });
      const stop = new AbortController();
      const admitted = f.engine["driver"]["admitNext"](f.task, stop.signal);
      await waitFor(() => f.task.agent?.profileId === "sol-high", "the Builder to wait in its place");
      stop.abort();
      f.engine.pause(f.task.id);
      await expectRejection(admitted, Aborted);
      held.release();
      await waitFor(() => f.check("codex").status === "ready", "the late readiness answer");
      expect(f.task.state).toBe("paused");
      expect(f.task.holdsSlot).toBe(false);
      expect(f.checks()).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });
});
