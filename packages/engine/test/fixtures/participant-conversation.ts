import { nativeAgentProcess } from "../native-agent.js";
import { expect, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { endAgentStep, ROLE_STARTS, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { executionFor } from "@petrina/orchestrator";
import { participantConversation } from "../../src/participant-conversation.js";
import * as gitOps from "@petrina/repositories/git";
import { Fakes, git, makeProduct, tempDir } from "../fixtures.js";
import { FixtureTrace } from "../fixture-trace.js";
import { completeAll } from "@petrina/core";

export function participantConversationFixtures() {
const fixtures = new Set<ReturnType<typeof directDrivers>>();
const traces = new Map<string, FixtureTrace>();
const observations: { mockRestore(): void }[] = [];
function observeGit(root: string, trace: FixtureTrace): void {
  traces.set(root, trace);
  // Install once for this test file. Concurrent fixtures register independently; finishing one
  // must not replace another's observer or restore exports while its Git calls are still pending.
  if (observations.length) return;
  const owner = (path: string) => [...traces].find(([root]) => path === root || path.startsWith(`${root}${sep}`))?.[1];
  const remove = gitOps.removeCopies, status = gitOps.worktreeStatus, run = gitOps.run, spawn = Bun.spawn;
  let capture: ((child: ReturnType<typeof Bun.spawn>) => void) | undefined;
  const spawnObserver = spyOn(Bun, "spawn"); observations.push(spawnObserver);
  spawnObserver.mockImplementation(((...args: unknown[]) => {
    const child = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    capture?.(child);
    return child;
  }) as typeof Bun.spawn);
  const removeObserver = spyOn(gitOps, "removeCopies"); observations.push(removeObserver);
  removeObserver.mockImplementation((...args) => owner(args[0])
    ?.during(`Removing review copies: ${args[1]}`, () => remove(...args)) ?? remove(...args));
  const statusObserver = spyOn(gitOps, "worktreeStatus"); observations.push(statusObserver);
  statusObserver.mockImplementation((...args) => owner(args[0])
    ?.during(`Checking the working copy: ${args[0]}`, () => status(...args)) ?? status(...args));
  const runObserver = spyOn(gitOps, "run"); observations.push(runObserver);
  runObserver.mockImplementation((...args) => {
    const trace = owner(args[1]);
    if (!trace) return run(...args);
    return trace.duringProcess(`Git in ${args[1]}: ${args[0].join(" ")}`, (observe) => {
      // run spawns synchronously before its first await. Scope capture to that call, so
      // simultaneous fixtures and unrelated agents cannot be attributed to this command.
      const previous = capture;
      capture = observe;
      try { return run(...args); }
      finally { capture = previous; }
    });
  });
}
async function fixture(pair = false, roleId = "code-reviewer", trace?: FixtureTrace) {
  trace?.mark("Creating the fixture repository");
  const root = tempDir("petrina-seat-conversation-");
  const lifetime = directDrivers(root); fixtures.add(lifetime);
  const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
  return setupWithCleanup(() => lifetime.prepare(async () => {
  if (trace) trace.snapshot = () => ({ root });
  const repo = await makeProduct(root), base = await git(repo, "rev-parse", "HEAD");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ reopen: "resume", addedReviewer: "pass" });
  const launches: { at: number; profileId: string; toolId: string }[] = [];
  trace?.mark("Waiting to create the fixture engine");
  trace?.mark("Creating the fixture engine");
  const engine = lifetime.open(join(root, "data"), {
      agentCommand: (profile) => {
        launches.push({ at: Date.now(), profileId: profile.id, toolId: profile.toolId });
        return [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`, "--trace-startup"];
      },
      toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
  });
  const ownedWork = () => ({
    stopped: engine.stopped,
    drivers: [...engine.drivers.keys()], settling: [...engine.settling.keys()],
    waiting: [...engine.waiting.keys()], admissions: [...engine.pendingAgentAdmissions],
    copyCleanups: [...engine.copyCleanups.keys()], cleanupJobs: [...engine.cleanupJobs],
    runs: [...engine.runs.values(), ...[...engine.helperRuns.values()].flatMap((runs) => [...runs])].map((run) => ({
      sessionId: run.sessionId, prompting: run.prompting, settings: run.settings,
      pid: nativeAgentProcess(run).pid, exitCode: nativeAgentProcess(run).exitCode, signalCode: nativeAgentProcess(run).signalCode,
    })),
    toolChecks: engine["tools"].pending().checking, lingeringTools: engine["tools"].pending().stopping,
    profileReads: engine["profileReader"].pending().checking, lingeringProfiles: engine["profileReader"].pending().stopping,
    yieldedStops: engine["turns"]["yieldedStops"].length,
  });
  if (trace) trace.snapshot = () => ({ root, ownedWork: ownedWork() });
  trace?.mark("Configuring controlled review seats");
  engine.schedule = () => {};
  // These cases exercise review seats, not installation or login. Start from a controlled ready
  // setup instead of opening four disposable agents and checking the real GitHub login per case.
  engine.s.setup!.checks = engine.s.tools.map((tool) => ({ id: tool.id as CheckId, status: "ready" }));
  engine.s.tools.forEach((tool) => { tool.status = "ready"; });
  if (roleId === "added") roleId = engine.addRole(ROLE_STARTS.find((role) => role.id === "security")!.draft);
  engine.s.pool.paused = false; engine.s.pool.limit = 3;
  engine.s.pool.toolCaps = { codex: 1, grok: 1 };
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "Keep each review seat", description: "ORIGINAL-SEAT-REQUEST", backlog: true });
  const task = engine.task(id)!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", baseSha: base, base: "main", report: { summary: "First report", changes: [] } });
  // Each planned seat has a same-effort stand-in on a different tool from its peer.
  engine.s.profiles.push({ ...engine.profile("astra-xhigh")!, id: "astra-high", effort: "high" });
  const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const, roleId, profileIds: pair ? ["opus-high", "sol-high"] : ["opus-high"] };
  task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] }; task.stageIndex = 0;
  task.brief = { summary: "UNCHANGED-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  const room = (toolId: string, profile: AgentProfile) => !slotWait(engine.activeState(), { ...profile, taskId: id, toolId });
  const choose = (seat = "0") => engine.choose(stage.profileIds[Number(seat)]!, scope, stage.roleId, room, seat)!;
  const round = async (number: number, peers: Record<string, string> = {}) => {
    trace?.mark(`Starting review round ${number}`);
    task.rounds[stage.id] = number;
    task.hunt = { stageId: stage.id, round: number, reported: {}, profiles: peers };
    if (Object.keys(peers).length) {
      await engine["reviews"]["input"](task, new AbortController().signal);
      task.hunt.reported = Object.fromEntries(Object.keys(peers).map((key) => [key, true]));
    }
    const hunt = () => engine["reviews"]["hunt"](task, stage, stage.profileIds.flatMap((profileId, index) => peers[String(index)] ? [] : [{ key: String(index), profileId }]), new AbortController().signal);
    await (trace ? trace.during(`Review round ${number}: reviewers and copy cleanup`, hunt) : hunt());
    trace?.mark(`Review round ${number}: recording the handoff`);
    endAgentStep(task, { outcome: "Reviewed", reason: "Controlled round completed" }, Date.now());
    engine.finishStep(scope);
    return task.journey!.at(-1)!.agentInputs!;
  };
  const first = async () => {
    engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 3_600_000, reason: "Controlled account limit" },
      ...(pair ? [{ toolId: "codex", model: "sol", until: Date.now() + 3_600_000, reason: "Controlled model quota" }] : [])];
    await round(1);
    const saved = structuredClone(task.reviewSessions![stage.id]!);
    engine.s.pool.limited = [];
    task.rounds[stage.id] = 2;
    delete task.hunt;
    scope.work.report!.summary = "CHANGED-BUILDER-REPORT";
    return saved;
  };
  const inspect = <T>(read: () => T) => {
    try { return read(); }
    catch (error) { return { unavailable: String(error) }; }
  };
  const log = (name: string) => inspect(() => readFileSync(join(fakes.dir, name), "utf8"));
  const diagnostics = () => ({
    choice: choose(),
    eligibility: participantConversation(engine, scope, engine.role(stage.roleId)!, engine.profile(stage.profileIds[0]!)!, "0"),
    profiles: engine.s.profiles.map(({ id, toolId, modelId, effort, standby }) => ({ id, toolId, modelId, effort, standby })), checks: engine.s.setup!.checks,
    pool: { usage: engine.s.pool.usage, limited: engine.s.pool.limited, toolCaps: engine.s.pool.toolCaps }, capacity: task.modelCapacity,
    saved: task.reviewSessions?.[stage.id], launches,
    inputs: task.journey?.at(-1)?.agentInputs?.map(({ mode, profileId, requestedProfileId, selectionReason }) => ({ mode, profileId, requestedProfileId, selectionReason })),
    opens: fakes.opens(),
    startup: log("startup.jsonl"),
    timeline: task.timeline.map((entry) => entry.text),
  });
  if (trace) {
    // Observe real boundaries rather than inventing a new wait or relying on a timeout's catch.
    const reviews = engine["reviews"], context = engine["context"];
    const input = reviews["input"].bind(reviews), capture = context.captureReview.bind(context);
    reviews["input"] = (...args) => trace.during(`Review round ${task.rounds[stage.id]}: preparing or reading saved evidence`, () => input(...args));
    context.captureReview = (...args) => trace.during(`Review round ${task.rounds[stage.id]}: capturing review context`, () => capture(...args));
    const turns = engine["turns"], released = turns.releasedStops.bind(turns), parallel = turns.parallel.bind(turns);
    turns.releasedStops = () => trace.during("Waiting for yielded reviewer processes", released);
    turns.parallel = <T>(...args: Parameters<typeof turns.parallel<T>>) => trace.during(`${args[7]?.key}: conversation and process stop`, () => parallel<T>(...args));
    // The saved failure had both reports and no agent processes left. Observe the remaining
    // Git and filesystem work too, without changing it or tracing other concurrent fixtures.
    observeGit(root, trace);
    trace.snapshot = () => ({
      root, taskId: task.id, state: task.state, status: task.statusLine,
      round: task.rounds[stage.id], hunt: task.hunt && {
        stageId: task.hunt.stageId, round: task.hunt.round, reported: task.hunt.reported,
        profiles: task.hunt.profiles, input: task.hunt.input, work: task.hunt.work,
      },
      saved: task.reviewSessions?.[stage.id],
      agents: [task.agent, ...(task.helpers ?? [])].filter(Boolean), ownedWork: ownedWork(),
      launches, startup: log("startup.jsonl"), opens: log("opens.jsonl"),
      prompts: inspect(() => fakes.received().map(({ role, session }) => ({ role, session }))),
      inputs: task.journey?.at(-1)?.agentInputs?.map(({ mode, profileId, requestedProfileId, selectionReason }) => ({ mode, profileId, requestedProfileId, selectionReason })),
      timeline: task.timeline.slice(-20).map((entry) => entry.text),
    });
    trace.mark("Fixture ready");
  }
  const closeTrace = () => { traces.delete(root); trace?.close(); };
  return { engine, task, scope, stage, fakes, choose,
    first: () => lifetime.run(engine, first),
    round: (...args: Parameters<typeof round>) => lifetime.run(engine, () => round(...args)),
    run: <T>(start: () => T | Promise<T>) => lifetime.run(engine, async () => start()),
    diagnostics, closeTrace, close };
  }), close);
}
async function conflicting(f: Awaited<ReturnType<typeof fixture>>) {
  return f.run(async () => {
  const main = f.scope.work.worktree!, copy = join(dirname(main), "task-copy");
  const commit = async (cwd: string, greeting: string) => {
    writeFileSync(join(cwd, "greeting.txt"), greeting);
    await git(cwd, "add", "."); await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", greeting);
  };
  await git(main, "worktree", "add", "-q", "-b", "task", copy);
  await commit(copy, "The task's greeting\n");
  Object.assign(f.scope.work, { worktree: copy, branch: "task", delivery: "local" });
  f.engine.s.products.find((product) => product.id === "p")!.remoteRefused = "No remote in this fixture";
  f.task.plan!.stages.push({ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] });
  return async (greeting: string) => f.run(async () => {
    await commit(main, greeting);
    expect(await f.engine["updates"].upToDate(f.scope, new AbortController().signal)).toBe("conflict");
    await commit(copy, `Ported: ${greeting}`);
    delete f.scope.work.updating;
    f.task.stageIndex = 0;
  });
  });
}
async function close() {
  try { await closeDirectDrivers(fixtures); fixtures.clear(); }
  finally { await completeAll(observations.map(async observation => { observation.mockRestore(); })); }
 }
return { fixture, conflicting, close };
}
