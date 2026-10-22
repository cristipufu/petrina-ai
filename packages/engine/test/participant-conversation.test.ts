import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { endAgentStep, ROLE_STARTS, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { executionFor } from "../src/repository-context.js";
import { participantConversation } from "../src/participant-conversation.js";
import * as gitOps from "../src/git.js";
import { Fakes, git, makeProduct, removeDir, tempDir } from "./support.js";
import { FixtureTrace } from "./fixture-trace.js";

const roots: string[] = [];
const traces = new Map<string, FixtureTrace>();
const observations: { mockRestore(): void }[] = [];
afterAll(() => { observations.forEach((observation) => observation.mockRestore()); roots.forEach(removeDir); });

function observeGit(root: string, trace: FixtureTrace): void {
  traces.set(root, trace);
  // Install once for this test file. Concurrent fixtures register independently; finishing one
  // must not replace another's observer or restore exports while its Git calls are still pending.
  if (observations.length) return;
  const owner = (path: string) => [...traces].find(([root]) => path === root || path.startsWith(`${root}${sep}`))?.[1];
  const remove = gitOps.removeCopies, status = gitOps.worktreeStatus, run = gitOps.run, spawn = Bun.spawn;
  let capture: ((child: ReturnType<typeof Bun.spawn>) => void) | undefined;
  observations.push(
    spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      const child = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
      capture?.(child);
      return child;
    }) as typeof Bun.spawn),
    spyOn(gitOps, "removeCopies").mockImplementation((...args) => owner(args[0])
      ?.during(`Removing review copies: ${args[1]}`, () => remove(...args)) ?? remove(...args)),
    spyOn(gitOps, "worktreeStatus").mockImplementation((...args) => owner(args[0])
      ?.during(`Checking the working copy: ${args[0]}`, () => status(...args)) ?? status(...args)),
    spyOn(gitOps, "run").mockImplementation((...args) => {
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
    }),
  );
}

/** Exercise the real review seats and context, without unrelated planning, building or voting. */
async function fixture(pair = false, roleId = "code-reviewer", trace?: FixtureTrace) {
  trace?.mark("Creating the fixture repository");
  const root = tempDir("petrina-seat-conversation-"); roots.push(root);
  if (trace) trace.snapshot = () => ({ root });
  const repo = makeProduct(root), base = git(repo, "rev-parse", "HEAD");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ reopen: "resume", addedReviewer: "pass" });
  const launches: { at: number; profileId: string; toolId: string }[] = [];
  trace?.mark("Creating the fixture engine");
  const engine = new Engine(join(root, "data"), {
    agentCommand: (profile) => {
      launches.push({ at: Date.now(), profileId: profile.id, toolId: profile.toolId });
      return [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--record-tool=${profile.toolId}`, "--trace-startup"];
    },
    toolPath: () => "/bin/true", usageCommands: { codex: null, grok: null, antigravity: null },
  });
  const ownedWork = () => ({
    stopped: engine.stopped,
    drivers: [...engine.drivers.keys()], settling: [...engine.settling.keys()],
    waiting: [...engine.waiting.keys()], admissions: [...engine.pendingAgentAdmissions],
    copyCleanups: [...engine.copyCleanups.keys()], cleanupJobs: [...engine.cleanupJobs],
    runs: [...engine.runs.values(), ...[...engine.helperRuns.values()].flatMap((runs) => [...runs])].map((run) => ({
      sessionId: run.sessionId, prompting: run.prompting, settings: run.settings,
      pid: run["child"].pid, exitCode: run["child"].exitCode, signalCode: run["child"].signalCode,
    })),
    toolChecks: [...engine["tools"]["checking"].keys()], lingeringTools: [...engine["tools"]["lingering"].keys()],
    profileReads: [...engine["profileReader"]["pending"].keys()], lingeringProfiles: [...engine["profileReader"]["lingering"].keys()],
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
  return { engine, task, scope, stage, fakes, choose, first, round, diagnostics, closeTrace };
}

describe.concurrent("eligible saved review stand-ins", () => {
  it("records held copy cleanup after both reviewers return, then preserves their handoff", async () => {
    const lines: string[] = [];
    const trace = new FixtureTrace("Held review cleanup", (line) => lines.push(line));
    const f = await fixture(true, "code-reviewer", trace).catch((error) => { trace.close(); throw error; });
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pruned = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>();
    const during = trace.during.bind(trace);
    trace.during = <T>(phase: string, work: () => Promise<T>) => during(phase, async () => {
      if (phase.startsWith("Removing review copies:") && Object.keys(f.task.hunt?.reported ?? {}).length === 2) {
        held.resolve();
        await release.promise;
      }
      return work();
    });
    const duringProcess = trace.duringProcess.bind(trace);
    trace.duringProcess = <T>(phase: string, work: Parameters<typeof trace.duringProcess<T>>[1]) => duringProcess(phase, async (capture) => {
      const result = await work(capture);
      if (phase.endsWith(": git worktree prune") && Object.keys(f.task.hunt?.reported ?? {}).length === 2) {
        pruned.resolve();
        await releaseResult.promise;
      }
      return result;
    });
    const round = f.round(1);
    try {
      await Promise.race([held.promise, round.then(() => { throw new Error("The review finished without observing copy cleanup"); })]);
      trace.report("still waiting");
      const evidence = JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!);
      expect(evidence.pending.some((entry: { phase: string }) => entry.phase.includes("Removing review copies:"))).toBe(true);
      expect(evidence.details.root).toBe(dirname(f.engine.dataDir));
      expect(evidence.progress.some((entry: { phase: string }) => entry.phase === "Waiting for yielded reviewer processes: complete")).toBe(true);
      expect(evidence.details.hunt.reported).toEqual({ "0": true, "1": true });
      expect(evidence.details.ownedWork.runs).toEqual([]);
      release.resolve();
      await Promise.race([pruned.promise, round.then(() => { throw new Error("The review finished without observing Git pruning"); })]);
      trace.report("still waiting");
      const afterExit = JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!);
      // The primary-copy status check runs beside pruning and may still be pending too.
      const pruning = afterExit.processes.filter((entry: { phase: string }) => entry.phase.endsWith(": git worktree prune"));
      expect(pruning).toHaveLength(1);
      expect(pruning[0]).toEqual(expect.objectContaining({
        phase: expect.stringContaining(": git worktree prune"), pid: expect.any(Number), exitWait: "completed", exitCode: 0, signalCode: null, hasExited: true,
      }));
      expect(afterExit.processes.every((entry: { phase: string }) => entry.phase.startsWith(`Git in ${dirname(f.engine.dataDir)}${sep}`))).toBe(true);
      expect(afterExit.pending.some((entry: { phase: string }) => entry.phase.endsWith(": git worktree prune"))).toBe(true);
      releaseResult.resolve();
      expect(await round).toHaveLength(2);
      expect(Object.keys(f.task.reviewSessions![f.stage.id]!)).toEqual(["0", "1"]);
      expect(git(f.scope.work.worktree!, "worktree", "list", "--porcelain")).not.toContain("task-1.copies");
      trace.report("complete");
      expect(JSON.parse(lines.at(-1)!.split("Held review cleanup: ")[1]!).processes).toEqual([]);
    } finally {
      release.resolve();
      releaseResult.resolve();
      try { await round; }
      finally { try { await f.engine.shutdown(); } finally { f.closeTrace(); } }
    }
  });

  for (const pair of [false, true]) it(`records the attempted ${pair ? "parallel" : "single"} seat when its fresh tool cannot start`, async () => {
    const f = await fixture(pair);
    try {
      const command = f.engine.options.agentCommand!;
      f.engine.options.agentCommand = (profile) => profile.toolId === "claude-code"
        ? [process.execPath, join(import.meta.dir, "fake-agent.ts"), "--wont-start"] : command(profile);
      await expect(f.round(1)).rejects.toMatchObject({ toolId: "claude-code", status: "wont-start" });
      expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === "opus-high")).toHaveLength(1);
      expect(f.task.session.filter((entry) => entry.from === "system" && entry.profileId === "opus-high" && entry.text.includes("joined ·"))).toHaveLength(1);
      expect(f.task.journey!.flatMap((step) => step.agentInputs ?? []).filter((input) => input.profileId === "opus-high")).toHaveLength(0);
    } finally { await f.engine.shutdown(); }
  });

  for (const pair of [false, true]) it(`announces each ${pair ? "parallel" : "single"} seat only once when a failed reopen selects the same planned profile`, async () => {
    const f = await fixture(pair);
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
      for (const seat of Object.values(saved)) rmSync(join(f.fakes.dir, "conversations", `${seat.sessionId}.json`));
      const note = { id: "current-revision", at: 1, text: "CURRENT-REVISION-NOTE" };
      f.task.notes = [note];
      f.task.stepNotes = [{ ...note, kind: "changes" }];
      const inputs = await f.round(2);
      expect(inputs).toHaveLength(pair ? 2 : 1);
      for (const input of inputs) {
        const prior = saved[input.reviewerKey!]!;
        expect(input.mode).toBe("fresh");
        expect(input.profileId).toBe(prior.profileId);
        expect(input.selectionReason).toContain("could not reopen");
        expect(input.taskDescription).toBe("ORIGINAL-SEAT-REQUEST");
        expect(input.sections.find((section) => section.title.startsWith("The coordinator's notes"))?.body).toContain(note.text);
        expect(input.sections.some((section) => section.title === "What the coordinator said in an earlier attempt at this step")).toBe(false);
        expect(f.fakes.received().filter((entry) => entry.session === prior.sessionId)).toHaveLength(1);
        expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === prior.profileId)).toHaveLength(2);
        expect(f.task.session.filter((entry) => entry.from === "system" && entry.profileId === prior.profileId && entry.text.includes("joined ·"))).toHaveLength(2);
      }
    } finally { await f.engine.shutdown(); }
  });

  for (const kind of ["single", "parallel", "security", "added"]) it(`keeps the ${kind} seats' own native conversations when planned profiles recover`, async () => {
    const pair = kind === "parallel";
    const f = await fixture(pair, kind === "security" ? "security-reviewer" : kind === "added" ? "added" : "code-reviewer");
    try {
      const saved = await f.first();
      expect(Object.values(saved).every((seat) => seat.profileId !== seat.plannedProfileId)).toBe(true);
      const booked = f.engine["driver"]["seatOf"]({ roleId: f.stage.roleId, profileId: "opus-high", reviewerKey: "0" }, f.task);
      expect(booked.toolId).toBe(saved["0"]!.toolId);
      const inputs = await f.round(2);
      expect(inputs).toHaveLength(pair ? 2 : 1);
      for (const input of inputs) {
        const prior = saved[input.reviewerKey!]!;
        expect(input.mode).toBe("continued");
        expect(input.profileId).toBe(prior.profileId);
        expect(input.requestedProfileId).toBe(prior.plannedProfileId);
        expect(input.taskDescription).toBeUndefined();
        expect(input.selectionReason).toContain("while the planned");
        expect(input.selectionReason).toContain("is available");
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(JSON.stringify(input.sections)).toContain("CHANGED-BUILDER-REPORT");
        const prompts = f.fakes.received(f.engine.role(f.stage.roleId)!.name.toLowerCase()).filter((entry) => entry.session === prior.sessionId);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).not.toContain("ORIGINAL-SEAT-REQUEST");
        expect(f.fakes.opens().filter((entry) => entry.session === prior.sessionId).map((entry) => entry.how)).toEqual(["new", "resume"]);
      }
      // Only the assigned seats opened conversations: no unrelated login probes in this fixture.
      expect(f.fakes.opens()).toHaveLength(pair ? 4 : 2);
      expect(new Set(inputs.map((input) => f.engine.profile(input.profileId)!.toolId)).size).toBe(inputs.length);
      expect(f.task.timeline.some((entry) => entry.text.includes("Kept its own conversation"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  for (const changed of ["assignment", "assignment to saved", "chosen", "usage", "capacity", "readiness", "login", "removed", "planned removed", "cap", "effort", "standby", "request", "role", "source", "port", "starting point", "peer", "builder", "context", "native"] as const) {
    it(`starts fresh with the recorded reason after ${changed} changes`, async () => {
      const trace = new FixtureTrace(`Review fixture after ${changed} changes`);
      const f = await fixture(changed === "peer", changed === "builder" ? "security-reviewer" : "code-reviewer", trace).catch((error) => {
        trace?.report("setup failed", error); trace?.close(); throw error;
      });
      try {
        const saved = (await f.first())["0"]!;
        trace?.mark("Applying the controlled seat change");
        let reason: string = changed;
        if (changed === "assignment") { f.stage.profileIds[0] = "grok-high"; reason = "you changed who works"; }
        else if (changed === "assignment to saved") { f.stage.profileIds[0] = saved.profileId; reason = "you changed who works"; }
        else if (changed === "chosen") { Object.assign(f.stage, { assignments: [{ profileId: "opus-high", by: "coordinator" }] }); reason = "you chose this seat"; }
        else if (changed === "usage") { f.engine.s.pool.limited = [{ toolId: saved.toolId, until: Date.now() + 3_600_000, reason: "Out" }]; reason = "out of usage"; }
        else if (changed === "capacity") { f.task.modelCapacity = [{ toolId: saved.toolId, modelId: saved.model, profileId: saved.profileId, until: Date.now() + 3_600_000 }]; reason = "saved model is full"; }
        else if (changed === "readiness" || changed === "login") { f.engine.s.setup!.checks.find((check) => check.id === saved.toolId)!.status = changed === "login" ? "logged-out" : "not-installed"; reason = changed === "login" ? "logged out" : "not ready"; }
        else if (changed === "removed") { f.engine.s.retiredProfiles = [f.engine.profile(saved.profileId)!]; f.engine.s.profiles = f.engine.s.profiles.filter((profile) => profile.id !== saved.profileId); reason = "no longer offered"; }
        else if (changed === "planned removed") { f.engine.s.retiredProfiles = [f.engine.profile("opus-high")!]; f.engine.s.profiles = f.engine.s.profiles.filter((profile) => profile.id !== "opus-high"); reason = "planned profile is no longer offered"; }
        else if (changed === "cap") { f.engine.s.pool.toolCaps[saved.toolId] = 0; reason = "no free agent slot"; }
        else if (changed === "effort" || changed === "standby") {
          // A valid saved scope at another effort/standby still does not earn the preference.
          const profile = f.engine.s.profiles.find((profile) => profile.id === saved.profileId)!;
          if (changed === "effort") profile.effort = "medium"; else profile.standby = true;
          const { reviewScopeKey } = await import("../src/review-context.js");
          f.task.reviewSessions![f.stage.id]!["0"]!.scope = reviewScopeKey(f.scope, f.stage.id, "0", f.engine.role(f.stage.roleId)!, f.engine.profile("opus-high"), profile);
          reason = changed === "effort" ? "different effort" : "standby profile";
        } else if (changed === "request") { f.task.description += " revised"; reason = "role, profile, request or starting point changed"; }
        else if (changed === "role") { f.engine.s.roles.find((role) => role.id === f.stage.roleId)!.instructions += " Revised"; reason = "role, profile, request or starting point changed"; }
        else if (changed === "source") { f.scope.work.source = { product: { id: "p", name: "Product", repo: "local/product" }, start: { kind: "branch", branch: "release" }, destination: { mode: "local", repo: "local/product", branch: "release", kind: "branch" }, confirmed: true }; reason = "role, profile, request or starting point changed"; }
        else if (changed === "port") { f.scope.work.portReview = { from: f.scope.work.baseSha!, head: f.scope.work.baseSha!, onto: f.scope.work.baseSha!, files: [] }; reason = "role, profile, request or starting point changed"; }
        else if (changed === "starting point") {
          const repo = f.scope.work.worktree!;
          const replacement = git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", `${f.scope.work.baseSha}^{tree}`, "-m", "Replace starting history");
          git(repo, "reset", "--hard", replacement);
          f.scope.work.baseSha = replacement;
          reason = "starting branch's history was replaced or diverged";
        }
        else if (changed === "peer") { f.task.hunt = { stageId: f.stage.id, round: 2, reported: { "1": true }, profiles: { "1": saved.profileId } }; reason = "Selected a more independent tool or model for this review."; }
        else if (changed === "builder") { f.scope.work.builderSession = { stageId: "build", profileId: saved.profileId, toolId: saved.toolId, model: saved.model, sessionId: "builder-own" }; reason = "Selected a more independent tool or model for this review."; }
        else if (changed === "context") { rmSync(saved.context!.file); reason = "saved context is unavailable"; }
        else if (changed === "native") { rmSync(join(f.fakes.dir, "conversations", `${saved.sessionId}.json`)); reason = "could not reopen"; }
        const inputs = await f.round(2, changed === "peer" ? { "1": saved.profileId } : {});
        trace?.mark("Checking the fresh conversation and selection reason");
        const input = inputs.find((input) => input.reviewerKey === "0")!;
        expect(input.mode).toBe("fresh");
        expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
        expect(input.selectionReason).toContain(reason);
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(true);
        expect(f.task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
        const current = f.task.reviewSessions![f.stage.id]!["0"]!;
        const prompts = f.fakes.received().filter((entry) => entry.session === current.sessionId);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]!.text).toContain("ORIGINAL-SEAT-REQUEST");
        expect(prompts[0]!.text).toContain("UNCHANGED-BRIEF");
        if (changed === "peer" || changed === "builder") expect(f.engine.profile(input.profileId)!.toolId).not.toBe(saved.toolId);
        if (["context", "native", "starting point"].includes(changed)) {
          expect(input.profileId).toBe("opus-high");
          expect(f.fakes.received().filter((entry) => entry.session === saved.sessionId)).toHaveLength(1);
        }
        if (changed === "native") {
          expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === saved.profileId)).toHaveLength(1);
          expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === input.profileId)).toHaveLength(1);
        }
      } catch (error) {
        trace?.report("test failed", error); throw error;
      } finally {
        try {
          await (trace ? trace.during("Stopping the fixture engine", () => f.engine.shutdown()) : f.engine.shutdown());
        } finally { f.closeTrace(); }
      }
    });
  }

  it("waits only for a readiness check already running on an otherwise eligible saved tool", async () => {
    const f = await fixture();
    try {
      const saved = (await f.first())["0"]!;
      const check = f.engine.s.setup!.checks.find((check) => check.id === saved.toolId)!;
      check.checking = true;
      expect(f.choose()).toEqual({ kind: "none", waiting: expect.stringContaining("before returning") });
      check.checking = false;
      expect(f.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }) }));
    } finally { await f.engine.shutdown(); }
  });

  it("retains reviewer policy near a limit and gives voters no saved-seat preference", async () => {
    const f = await fixture();
    try {
      const saved = (await f.first())["0"]!;
      f.engine.s.pool.usage = [{ toolId: saved.toolId, kind: "seven_day", utilization: 0.9, status: "allowed", at: Date.now(), resetsAt: Date.now() + 3_600_000 }];
      expect(f.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }) }));
      expect(f.engine.choose("opus-high", f.scope, "verifier")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: "opus-high" }) }));
      const before = structuredClone(f.diagnostics());
      try {
        const input = (await f.round(2))[0]!;
        expect(input.mode).toBe("continued");
      } catch (error) {
        console.error("Near-limit reviewer continuation:", JSON.stringify({ before, after: f.diagnostics() }, null, 2));
        throw error;
      }
    } finally { await f.engine.shutdown(); }
  });

  it("checks the new tool's cap after a parallel reopen fails, and retains the reason through the wait", async () => {
    const f = await fixture(true);
    try {
      const saved = (await f.first())["0"]!;
      rmSync(join(f.fakes.dir, "conversations", `${saved.sessionId}.json`));
      f.engine.s.pool.toolCaps["claude-code"] = 0;
      const firstPrompts = f.fakes.received().length;
      await expect(f.round(2)).rejects.toThrow("Waiting for a free");
      expect(f.task.reviewSessions![f.stage.id]!["0"]!.freshReason).toContain("could not reopen");
      expect(f.task.journey!.at(-1)!.agentInputs!.some((input) => input.reviewerKey === "0")).toBe(false);
      expect(f.fakes.received().length).toBe(firstPrompts + 1); // Only the healthy peer received instructions.
      f.engine.s.pool.toolCaps["claude-code"] = 1;
      await f.engine["reviews"]["hunt"](f.task, f.stage, [{ key: "0", profileId: "opus-high" }], new AbortController().signal);
      const input = f.task.journey!.at(-1)!.agentInputs!.find((input) => input.reviewerKey === "0")!;
      expect(input.mode).toBe("fresh");
      expect(input.profileId).toBe("opus-high");
      expect(input.selectionReason).toContain("could not reopen");
      expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
    } finally { await f.engine.shutdown(); }
  });
});
