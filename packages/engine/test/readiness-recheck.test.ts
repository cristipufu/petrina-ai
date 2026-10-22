import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endAgentStep, slotUses, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "../src/repository-context.js";
import { Aborted } from "../src/kernel.js";
import { WaitingForUsage } from "../src/usage.js";
import { BuildResult } from "../src/roles.js";
import { Fakes, git, makeProduct, removeDir, SLOW, tempDir, waitFor } from "./fixtures.js";
import { expectRejection, rejectionOf } from "./rejections.js";

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
    agentCommand: (profile) => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`, ...(inChecks[profile.toolId] ?? [])],
    toolPath: () => "/bin/true", usageCommands: { codex: null, grok: null, antigravity: null },
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
async function fixture(options: { pair?: boolean; checkTimeoutMs?: number } = {}) {
  const root = tempDir("petrina-readiness-recheck-");
  roots.push(root);
  const { engine, fakes, checks, check, uncertain, holdCheck, inChecks, name } = engineIn(root, options.checkTimeoutMs);
  const repo = makeProduct(root), base = git(repo, "rev-parse", "HEAD");
  fakes.scenario({ reopen: "resume" });
  engine.s.setup!.checks = engine.s.tools.map((tool) => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach((tool) => { tool.status = "ready"; });
  engine.s.pool.paused = false; engine.s.pool.limit = 3;
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "Recheck the saved seat", description: "ORIGINAL-SEAT-REQUEST", backlog: true });
  const task = engine.task(id)!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", baseSha: base, base: "main", report: { summary: "First report", changes: [] } });
  const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: options.pair ? ["opus-high", "grok-high"] : ["opus-high"] };
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
      expect(f.engine["tools"]["checking"].size).toBe(0);
      expect(f.engine["tools"]["lingering"].size).toBe(0);
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
    f.engine.s.pool.limit = 2;
    f.busy("other", "grok-high");
    f.uncertain("codex");
    return f;
  }

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
