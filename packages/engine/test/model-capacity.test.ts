import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotWait, usageLines, type AgentProfile, type RoutineDraft, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "@petrina/orchestrator";
import { failureReason } from "../src/tracking.js";
import { CAPACITY_WAIT, capacityRetryDelay, capacityWaiting, CODEX_MODEL_CAPACITY, codexCapacityFailure, codexModelAtCapacity, limitFromFailure, MODEL_CAPACITY_WAIT_MS, ModelAtCapacity, WaitingForCapacity, WaitingForUsage } from "../src/usage.js";
import type { NativeStep, Scenario } from "./fake-agent.js";
import { Fakes, FAKE_AGENT, git, makeProduct, makeWorld, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const SENTENCE = CODEX_MODEL_CAPACITY;

/** Finishing the task, or reaching a step deep in it, runs its planning, building, checks and review starts. */
const TASK_MS = 60_000;

/** Long enough that a held wait outlasts any test; `endCapacityWait` ends it. */
const HELD_MS = 60 * 60_000;

/** A full-model wait as the engine recorded it: who stopped, their short retries so far, and the delay the engine chose. */
interface CapacityStop { taskId: string; modelId: string; profileId: string; roleId: string; tried: number; waitMs: number; seen?: boolean }

/**
 * Every full-model wait the engine records, in order. Each one is held from the moment it is recorded, so the step
 * cannot go on by itself before the test has looked at it, however long a peer keeps working or the task takes to
 * let go. Its delay is checked as the engine chose it, not read back from a clock. `endCapacityWait` ends the wait.
 */
function holdCapacityWaits(engine: Engine): CapacityStop[] {
  const stops: CapacityStop[] = [];
  const record = engine.recordModelCapacity.bind(engine);
  engine.recordModelCapacity = (...args: Parameters<Engine["recordModelCapacity"]>) => {
    record(...args);
    const [task, roleId, profileId, error, waitMs] = args;
    const tried = task.capacityRetries?.find((entry) => entry.roleId === roleId && entry.profileId === profileId)?.tried ?? 0;
    stops.push({ taskId: task.id, modelId: error.modelId, profileId, roleId, tried, waitMs: waitMs ?? MODEL_CAPACITY_WAIT_MS });
    const entry = task.modelCapacity?.find((item) => item.toolId === error.toolId && item.modelId === error.modelId);
    if (entry) entry.until = Date.now() + HELD_MS;
  };
  return stops;
}

/** One task on fake agents, delivering locally, with every tool counted as installed. */
async function start(scenario: Scenario, options: { description?: string; before?: (engine: Engine) => void } = {}) {
  const root = tempDir("petrina-capacity-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => process.execPath });
  const stops = holdCapacityWaits(engine);
  options.before?.(engine);
  const productId = await engine.addProduct(await makeProduct(root));
  engine.setProductDelivery(productId, "local", false);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: options.description ?? "[no-check]" });
  const find = () => engine.getState().tasks.find((task) => task.id === taskId) as Task;
  const answer = () => {
    for (const item of engine.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  const read = () => { answer(); return find(); };
  const done = () =>
    waitFor(() => {
      answer();
      const task = find();
      if (task.state === "failed") throw new Error(`The task failed: ${task.error}`);
      return task.state === "done" && task;
    }, "the task to finish", TASK_MS);
  const modelOf = (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice("model=".length);
  const effortOf = (session: string) => {
    const line = fakes.settings(session).find((entry) => entry.startsWith("effort=") || entry.startsWith("reasoning_effort="));
    return line?.slice(line.indexOf("=") + 1);
  };
  return { root, engine, fakes, find, read, done, answer, modelOf, effortOf, taskId, stops };
}

type Run = Awaited<ReturnType<typeof start>>;

const live = (run: Run) => run.engine.s.tasks.find((task) => task.id === run.taskId)!;

const SHORT_WAITS = [5_000, 10_000, 30_000] as const;

function namedModels(modelId: string | readonly string[] = "gpt-6.1-sol"): string[] {
  return typeof modelId === "string" ? [modelId] : [...modelId];
}

function capacityEntries(engine: Engine, taskId: string, modelId: string | readonly string[] = "gpt-6.1-sol") {
  const ids = new Set(namedModels(modelId));
  return engine.s.tasks.find((task) => task.id === taskId)?.modelCapacity?.filter((item) => ids.has(item.modelId)) ?? [];
}

/** A task whose full-model waits are held, and a read that answers its questions. */
interface Held { engine: Engine; taskId: string; stops: CapacityStop[]; read: () => Task | undefined }

/**
 * The next held wait on each named model: the delay the engine chose and, when given, which short retry it is. Getting
 * there can take the task's earlier steps. Then the whole task waits for it: a peer still working keeps the task
 * running, so this returns once the group has settled and the driver has let go.
 */
async function capacityWait(held: Held, delay: number, modelId: string | readonly string[] = "gpt-6.1-sol", tried?: number): Promise<Task> {
  const ids = namedModels(modelId);
  const read = () => {
    const task = held.read();
    if (task?.state === "failed") throw new Error(task.error ?? "The task failed");
    return task;
  };
  const stops = await waitFor(() => {
    read();
    const next = ids.map((id) => held.stops.find((stop) => !stop.seen && stop.taskId === held.taskId && stop.modelId === id));
    return next.every((stop) => stop !== undefined) && (next as CapacityStop[]);
  }, `${ids.join(" and ")} to stop at capacity`, TASK_MS);
  for (const stop of stops) {
    stop.seen = true;
    expect(stop.waitMs).toBe(delay);
    if (tried !== undefined) expect(stop.tried).toBe(tried);
  }
  return waitFor(() => {
    const task = read();
    return task?.state === "waiting" && task.statusLine.startsWith(CAPACITY_WAIT) && !held.engine.drivers.has(held.taskId) && !held.engine.settling.has(held.taskId) && task;
  }, `the task to wait about ${Math.round(delay / 1000)} seconds for a full model`);
}

/** End a held wait now: it moves into the past and the scheduler runs, so the step continues without a real delay. */
function endCapacityWait(engine: Engine, taskId: string, modelId: string | readonly string[] = "gpt-6.1-sol") {
  const entries = capacityEntries(engine, taskId, modelId);
  if (!entries.length) throw new Error("The task is not waiting on a full model");
  for (const entry of entries) entry.until = Date.now() - 1;
  engine.schedule();
}

/** End a held wait once the whole task has let go of its step. */
async function releaseCapacity(engine: Engine, taskId: string, modelId: string | readonly string[] = "gpt-6.1-sol") {
  await waitFor(() => !engine.drivers.has(taskId) && !engine.settling.has(taskId), "the capacity wait to let go of the task");
  endCapacityWait(engine, taskId, modelId);
}

/** The same conversation's short retries, from the `first` one: each is checked while held, then released. */
async function sameModelWaits(run: Run, delays: readonly number[], modelId = "gpt-6.1-sol", first = 1) {
  for (const [index, delay] of delays.entries()) {
    await capacityWait(run, delay, modelId, first + index);
    await releaseCapacity(run.engine, run.taskId, modelId);
  }
}

function expectShortContinues(prompts: { text: string }[]) {
  for (const prompt of prompts) {
    expect(prompt.text.startsWith("The selected model was at capacity.")).toBe(true);
    expect(prompt.text).not.toContain("# Your job");
    expect(prompt.text).not.toContain("Petrina restarted");
  }
}

function assertNotAccountLimit(run: Run, task: Task, toolId = "codex") {
  expect(task.error).toBeUndefined();
  expect(task.state).not.toBe("failed");
  expect(run.engine.getState().pool.limited ?? []).toEqual([]);
  expect(usageLines(run.engine.getState(), Date.now()).find((line) => line.toolId === toolId)?.tone).not.toBe("out");
  expect(task.timeline.some((entry) => entry.text.includes("ran out of usage") || entry.text.includes("Waiting for usage"))).toBe(false);
  expect(run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["failure"] }).some((moment) => moment.outcome === "limit")).toBe(false);
  expect(run.fakes.prompts().some((text) => text.includes("Your result block could not be used"))).toBe(false);
}

const roundOf = (task: Task, roleId: string) => {
  const stage = task.plan?.stages.find((item) => item.roleId === roleId);
  return stage ? task.rounds[stage.id] ?? 1 : undefined;
};

/** Only Codex is ready, and the other Codex model is not offered. */
function onlySol(engine: Engine) {
  onlyCodex(engine);
  engine.s.profiles = engine.s.profiles.filter((profile) => profile.modelId !== "gpt-6-astra");
}

/** Only Codex is ready. Both Codex models stay offered. */
function onlyCodex(engine: Engine) {
  engine.s.setup!.checks = [
    { id: "claude-code", status: "logged-out" },
    { id: "codex", status: "ready" },
    { id: "grok", status: "logged-out" },
    { id: "antigravity", status: "logged-out" },
  ];
}

describe.concurrent("a Codex model that is at capacity", () => {
  for (const [name, capacity] of [
    ["before any work", { model: "gpt-6.1-sol", role: "builder", times: 4 }],
    ["after a draft and a file", { model: "gpt-6.1-sol", role: "builder", partial: true, times: 4 }],
    ["when the tool reports it as an error", { model: "gpt-6.1-sol", role: "builder", thrown: true, times: 4 }],
  ] as const) {
    it(`retries the same conversation, then continues the same step on another Codex model ${name}`, async () => {
      const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [capacity] });
      try {
        await sameModelWaits(run, SHORT_WAITS);
        const task = await run.done();
        assertNotAccountLimit(run, task);
        expect(task.timeline.some((entry) => entry.text.includes("stopped because the selected model is at capacity"))).toBe(true);
        expect(roundOf(task, "code-reviewer")).toBe(1);
        const builders = run.fakes.received("builder");
        const first = builders[0]!;
        const same = builders.filter((entry) => entry.session === first.session);
        const next = builders.find((entry) => entry.session !== first.session)!;
        expect(same).toHaveLength(4);
        expect(same[0]!.text).toContain("# Your job");
        expectShortContinues(same.slice(1));
        expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume"]);
        expect(run.modelOf(next.session)).toBe("gpt-6-astra");
        expect(run.effortOf(next.session)).toBe("xhigh");
        expect(run.modelOf(first.session)).toBe("gpt-6.1-sol");
        expect(next.text).toContain("could not continue (the selected model is at capacity)");
        expect(next.text).not.toContain("ran out of usage");
        if ("partial" in capacity && capacity.partial) {
          expect(next.text).toContain("I drafted the greeting before the model filled up.");
          expect(next.text).toContain("capacity-draft.txt");
        }
      } finally { await run.engine.shutdown(); }
    });
  }

  it("waits about five minutes after the short retries when nothing else can take the step", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", times: 4 }] }, { before: onlySol });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      const waiting = await capacityWait(run, 5 * 60_000);
      expect(live(run).capacityRetries?.some((entry) => entry.tried === 3)).toBe(true);
      expect(waiting.holdsSlot).toBe(false);
      expect(waiting.agent).toBeUndefined();
      expect(waiting.statusLine).not.toContain("Waiting for usage");
      expect(waiting.conversation).toMatchObject({ roleId: "builder", briefed: true });
      const session = run.fakes.received("builder")[0]!.session;
      expect(waiting.conversation?.sessionId).toBe(session);
      const head = await git(waiting.worktree!, "rev-parse", "HEAD");
      expect(waiting.baseSha).toBe(head);
      expect(await git(waiting.worktree!, "status", "--porcelain")).toBe("");
      assertNotAccountLimit(run, waiting);
      await releaseCapacity(run.engine, run.taskId);
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(5);
      expect(builders.every((entry) => entry.session === session)).toBe(true);
      expect(builders[0]!.text).toContain("# Your job");
      expectShortContinues(builders.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume", "resume"]);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps a draft while it waits, then continues in the same conversation", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", partial: true }] }, { before: onlySol });
    try {
      const waiting = await capacityWait(run, 5_000);
      expect(readFileSync(join(waiting.worktree!, "capacity-draft.txt"), "utf8")).toBe("A greeting draft\n");
      expect(waiting.session.some((line) => line.from === "agent" && line.text.includes("I drafted the greeting before the model filled up."))).toBe(true);
      expect(waiting.conversation?.sessionId).toBe(run.fakes.received("builder")[0]!.session);
      const head = await git(waiting.worktree!, "rev-parse", "HEAD");
      expect(waiting.baseSha).toBe(head);
      expect(await git(waiting.worktree!, "status", "--porcelain")).toContain("capacity-draft.txt");
      await releaseCapacity(run.engine, run.taskId);
      await waitFor(() => {
        run.answer();
        return run.fakes.received("builder").length >= 2;
      }, "the same conversation to continue");
      expect(existsSync(join(run.find().worktree!, "capacity-draft.txt"))).toBe(true);
      expect(await git(run.find().worktree!, "rev-parse", "HEAD")).toBe(head);
      const again = run.fakes.received("builder")[1]!.text;
      expect(again.startsWith("The selected model was at capacity.")).toBe(true);
      expect(again).not.toContain("# Your job");
      await run.done();
    } finally { await run.engine.shutdown(); }
  });

  it("continues on another tool after the short retries when no other Codex model is free", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", partial: true, times: 4 }] }, {
      before: (engine) => { engine.s.profiles = engine.s.profiles.filter((profile) => profile.modelId !== "gpt-6-astra"); },
    });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      const task = await run.done();
      assertNotAccountLimit(run, task);
      const builders = run.fakes.received("builder");
      const first = builders[0]!;
      const next = builders.find((entry) => entry.session !== first.session)!;
      expect(run.modelOf(first.session)).toBe("gpt-6.1-sol");
      expect(builders.filter((entry) => entry.session === first.session)).toHaveLength(4);
      expectShortContinues(builders.filter((entry) => entry.session === first.session).slice(1));
      expect(run.modelOf(next.session)).toBe("opus");
      expect(run.effortOf(next.session)).toBe("xhigh");
      expect(next.text).toContain("could not continue (the selected model is at capacity)");
      expect(next.text).toContain("capacity-draft.txt");
      expect(roundOf(task, "code-reviewer")).toBe(1);
    } finally { await run.engine.shutdown(); }
  });

  it("recognizes Codex's overloaded stop and retries the same conversation", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", partial: true, native: true }] });
    try {
      const waiting = await capacityWait(run, 5_000);
      expect(readFileSync(join(waiting.worktree!, "capacity-draft.txt"), "utf8")).toBe("A greeting draft\n");
      expect(waiting.session.some((line) => line.from === "agent" && line.text.includes("I drafted the greeting before the model filled up."))).toBe(true);
      expect(waiting.session.some((line) => line.from === "agent" && line.text.trimEnd().endsWith(SENTENCE))).toBe(false);
      expect(run.fakes.prompts().some((text) => text.includes("Your result block could not be used"))).toBe(false);
      const session = run.fakes.received("builder")[0]!.session;
      expect(run.modelOf(session)).toBe("gpt-6.1-sol");
      await releaseCapacity(run.engine, run.taskId);
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(2);
      expect(builders.every((entry) => entry.session === session)).toBe(true);
      expect(builders[1]!.text.startsWith("The selected model was at capacity.")).toBe(true);
      expect(builders[1]!.text).not.toContain("# Your job");
      expect(roundOf(task, "code-reviewer")).toBe(1);
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("honors a provider retry delay before continuing the same conversation", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", thrown: true, retryAfterMs: 45_000 }] });
    try {
      await capacityWait(run, 45_000);
      const session = run.fakes.received("builder")[0]!.session;
      expect(run.modelOf(session)).toBe("gpt-6.1-sol");
      await releaseCapacity(run.engine, run.taskId);
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(2);
      expect(builders.every((entry) => entry.session === session)).toBe(true);
      expect(builders[1]!.text.startsWith("The selected model was at capacity.")).toBe(true);
      expect(builders[1]!.text).not.toContain("# Your job");
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("accepts a finished result that only mentions the sentence", async () => {
    const run = await start({ planner: "short", builder: "plain", mentionCapacity: true });
    try {
      const task = await run.done();
      expect(run.fakes.received("builder")).toHaveLength(1);
      expect(task.timeline.some((entry) => entry.text.includes("at capacity"))).toBe(false);
      expect(live(run).modelCapacity).toBeUndefined();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps the other reviewer's result and does not spend a review round", async () => {
    // The reviewer on Opus keeps working until the test lets it finish, so the full model's first wait starts and ends beside it.
    const run = await start({
      planner: "parallel",
      builder: "plain",
      reopen: "resume",
      capacity: [{ model: "gpt-6.1-sol", role: "code reviewer", partial: true, times: 4 }],
      nativeRetry: [{ role: "code reviewer", model: "opus", steps: [{ mark: "opus-reviewing" }, { wait: "opus-may-finish" }] }],
    });
    try {
      const [opening] = await waitFor(() => {
        const stops = run.stops.filter((stop) => stop.modelId === "gpt-6.1-sol");
        const task = run.read();
        if (task.state === "failed") throw new Error(task.error ?? "The task failed");
        const agents = [task.agent, ...(task.helpers ?? [])].map((agent) => agent?.profileId);
        return stops.length > 0 && run.fakes.marked("opus-reviewing") && agents.join() === "opus-high" && stops;
      }, "the full reviewer to wait while the reviewer on Opus works", TASK_MS);
      expect(opening).toMatchObject({ tried: 1, waitMs: 5_000 });
      opening!.seen = true;
      const working = live(run);
      expect(working.state).toBe("running");
      expect(working.holdsSlot).toBe(true);
      expect(working.capacityRetries).toEqual([expect.objectContaining({ profileId: "sol-high", member: "review-1", tried: 1 })]);
      expect(working.capacityResume).toEqual([expect.objectContaining({ profileId: "sol-high", member: "review-1" })]);
      // The wait ends while the peer still works. The full reviewer goes on in its own conversation once the peer has reported.
      endCapacityWait(run.engine, run.taskId);
      writeFileSync(join(run.fakes.dir, "opus-may-finish"), "");
      await sameModelWaits(run, SHORT_WAITS.slice(1), "gpt-6.1-sol", 2);
      const task = await run.done();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      expect(task.findings.some((finding) => finding.raisedBy === "opus-high")).toBe(true);
      const reviewers = run.fakes.received("code reviewer");
      expect(reviewers.filter((entry) => run.modelOf(entry.session) === "opus")).toHaveLength(1);
      const first = reviewers.find((entry) => run.modelOf(entry.session) === "gpt-6.1-sol")!;
      const next = reviewers.find((entry) => entry.session !== first.session && run.modelOf(entry.session) === "gpt-6-astra")!;
      expect(reviewers.filter((entry) => entry.session === first.session)).toHaveLength(4);
      expectShortContinues(reviewers.filter((entry) => entry.session === first.session).slice(1));
      expect(run.effortOf(next.session)).toBe("xhigh");
      expect(next.text).toContain("could not continue (the selected model is at capacity)");
      expect(next.text).toContain("I drafted the greeting before the model filled up.");
      expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume"]);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps the design round when the design reviewer's model is full", async () => {
    const run = await start({ builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "design reviewer", times: 4 }] });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      const building = await waitFor(() => {
        run.answer();
        const task = run.find();
        if (task.state === "failed") throw new Error(task.error);
        return run.fakes.received("builder").length > 0 && task.plan && task;
      }, "the build to start");
      expect(roundOf(building, "architect")).toBe(1);
      const reviewers = run.fakes.received("design reviewer");
      const first = reviewers[0]!;
      const next = reviewers.find((entry) => entry.session !== first.session)!;
      expect(run.modelOf(first.session)).toBe("gpt-6.1-sol");
      expect(reviewers.filter((entry) => entry.session === first.session)).toHaveLength(4);
      expect(run.modelOf(next.session)).toBe("gpt-6-astra");
      expect(run.effortOf(next.session)).toBe("xhigh");
      const task = await run.done();
      expect(roundOf(task, "architect")).toBe(1);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("continues a replacement reviewer after the original model is free again", async () => {
    const run = await start({
      planner: "parallel",
      builder: "plain",
      reopen: "resume",
      capacity: [
        { model: "gpt-6.1-sol", role: "code reviewer", times: 4 },
        { model: "gpt-6-astra", role: "code reviewer", times: 1, thrown: true, retryAfterMs: 10 * 60_000 },
      ],
    });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      await capacityWait(run, 10 * 60_000, "gpt-6-astra", 1);
      expect(capacityEntries(run.engine, run.taskId, "gpt-6.1-sol")).toHaveLength(1);
      expect(live(run).capacityPaused?.some((entry) => entry.profileId === "astra-xhigh" && entry.plannedId === "sol-high")).toBe(true);
      expect(live(run).capacityResume?.some((entry) => entry.profileId === "astra-xhigh")).toBe(true);
      await releaseCapacity(run.engine, run.taskId, ["gpt-6.1-sol", "gpt-6-astra"]);
      const task = await run.done();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      expect(task.findings.some((finding) => finding.raisedBy === "opus-high")).toBe(true);
      const reviewers = run.fakes.received("code reviewer");
      const sol = reviewers.filter((entry) => run.modelOf(entry.session) === "gpt-6.1-sol");
      const astra = reviewers.filter((entry) => run.modelOf(entry.session) === "gpt-6-astra");
      expect(sol).toHaveLength(4);
      expect(new Set(sol.map((entry) => entry.session)).size).toBe(1);
      expectShortContinues(sol.slice(1));
      expect(astra).toHaveLength(2);
      expect(new Set(astra.map((entry) => entry.session)).size).toBe(1);
      expect(astra[0]!.text).toContain("could not continue (the selected model is at capacity)");
      expectShortContinues(astra.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === astra[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps a Codex vote on another Codex model after the short retries", async () => {
    const run = await start({ planner: "short", builder: "plain", reviewer: "important", verifier: "not-a-bug", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "verifier", times: 4 }] });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      const task = await run.done();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      const votes = task.findings.flatMap((finding) => finding.votes ?? []);
      expect(votes.some((vote) => vote.by === "astra-xhigh")).toBe(true);
      expect(votes.every((vote) => run.engine.profile(vote.by)?.modelId !== "gpt-6.1-sol")).toBe(true);
      const verifiers = run.fakes.received("verifier");
      const first = verifiers.find((entry) => run.modelOf(entry.session) === "gpt-6.1-sol")!;
      expect(verifiers.filter((entry) => entry.session === first.session)).toHaveLength(4);
      expectShortContinues(verifiers.filter((entry) => entry.session === first.session).slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume"]);
    } finally { await run.engine.shutdown(); }
  });

  it("keeps a replacement voter's conversation and moves on to the longer wait", async () => {
    const run = await start({
      planner: "short",
      builder: "plain",
      reviewer: "important",
      verifier: "not-a-bug",
      reopen: "resume",
      capacity: [
        { model: "gpt-6.1-sol", role: "verifier", times: 4 },
        { model: "gpt-6-astra", role: "verifier", times: 2 },
      ],
    });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      await capacityWait(run, 5_000, "gpt-6-astra", 1);
      const first = live(run).capacityRetries?.find((entry) => entry.profileId === "astra-xhigh");
      expect(first).toMatchObject({ tried: 1, member: "vote-sol-high" });
      expect(live(run).capacityResume?.some((entry) => entry.profileId === "astra-xhigh" && entry.member === "vote-sol-high")).toBe(true);
      await releaseCapacity(run.engine, run.taskId, "gpt-6-astra");
      await capacityWait(run, 10_000, "gpt-6-astra", 2);
      expect(live(run).capacityRetries?.filter((entry) => entry.profileId === "astra-xhigh")).toEqual([
        expect.objectContaining({ tried: 2, member: "vote-sol-high" }),
      ]);
      const midway = run.fakes.received("verifier").filter((entry) => run.modelOf(entry.session) === "gpt-6-astra");
      expect(midway).toHaveLength(2);
      expect(new Set(midway.map((entry) => entry.session)).size).toBe(1);
      expectShortContinues(midway.slice(1));
      await releaseCapacity(run.engine, run.taskId, "gpt-6-astra");
      const task = await run.done();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      const votes = task.findings.flatMap((finding) => finding.votes ?? []);
      expect(votes.some((vote) => vote.by === "astra-xhigh")).toBe(true);
      const verifiers = run.fakes.received("verifier");
      const sol = verifiers.filter((entry) => run.modelOf(entry.session) === "gpt-6.1-sol");
      const astra = verifiers.filter((entry) => run.modelOf(entry.session) === "gpt-6-astra");
      expect(sol).toHaveLength(4);
      expect(new Set(sol.map((entry) => entry.session)).size).toBe(1);
      expectShortContinues(sol.slice(1));
      expect(astra).toHaveLength(3);
      expect(new Set(astra.map((entry) => entry.session)).size).toBe(1);
      expectShortContinues(astra.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === astra[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume"]);
    } finally { await run.engine.shutdown(); }
  });

  it("waits to vote when every Codex model is full, then continues that vote", async () => {
    const run = await start({ planner: "short", builder: "plain", reviewer: "important", verifier: "not-a-bug", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "verifier", times: 4 }] }, {
      before: (engine) => { engine.s.profiles = engine.s.profiles.filter((profile) => profile.modelId !== "gpt-6-astra"); },
    });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      const waiting = await capacityWait(run, 5 * 60_000);
      expect(roundOf(waiting, "code-reviewer")).toBe(1);
      const early = waiting.findings.flatMap((finding) => finding.votes ?? []);
      expect(early.some((vote) => vote.toolId !== "codex")).toBe(true);
      expect(early.some((vote) => vote.toolId === "codex")).toBe(false);
      expect(waiting.findings.every((finding) => finding.verification === undefined)).toBe(true);
      expect(run.engine.getState().pool.limited ?? []).toEqual([]);
      expect(live(run).capacityRetries?.some((entry) => entry.tried === 3)).toBe(true);
      await releaseCapacity(run.engine, run.taskId);
      const task = await run.done();
      expect(roundOf(task, "code-reviewer")).toBe(1);
      const votes = task.findings.flatMap((finding) => finding.votes ?? []);
      expect(votes.some((vote) => vote.by === "sol-high")).toBe(true);
      expect(votes.filter((vote) => vote.toolId === "codex").every((vote) => vote.by === "sol-high")).toBe(true);
      expect(task.findings.some((finding) => finding.verification !== undefined)).toBe(true);
      const sol = run.fakes.received("verifier").filter((entry) => run.modelOf(entry.session) === "gpt-6.1-sol");
      expect(sol).toHaveLength(5);
      expectShortContinues(sol.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === sol[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume", "resume"]);
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("retries the same profile when the agent already has the screen", async () => {
    const run = await start({ planner: "short", builder: "plain", screen: "ask", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", onScreen: true, times: 4 }] }, {
      before: (engine) => engine.setScreenUse("on"),
    });
    try {
      const waiting = await capacityWait(run, 5_000, "gpt-6.1-sol", 1);
      expect(waiting.screen).toMatchObject({ granted: true, profileId: "sol-xhigh", roleId: "builder" });
      expect(run.fakes.received("builder")).toHaveLength(2);
      expect(existsSync(join(waiting.worktree!, "notes.txt"))).toBe(true);
      expect(run.modelOf(run.fakes.received("builder")[0]!.session)).toBe("gpt-6.1-sol");
      await releaseCapacity(run.engine, run.taskId);
      await capacityWait(run, 10_000, "gpt-6.1-sol", 2);
      await releaseCapacity(run.engine, run.taskId);
      await capacityWait(run, 30_000, "gpt-6.1-sol", 3);
      await releaseCapacity(run.engine, run.taskId);
      const held = await capacityWait(run, 5 * 60_000);
      expect(held.screen).toMatchObject({ granted: true, profileId: "sol-xhigh", roleId: "builder" });
      expect(run.fakes.received("builder").every((entry) => run.modelOf(entry.session) === "gpt-6.1-sol")).toBe(true);
      expect(live(run).capacityRetries?.some((entry) => entry.tried === 3)).toBe(true);
      await releaseCapacity(run.engine, run.taskId);
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(6);
      expect(new Set(builders.map((entry) => entry.session)).size).toBe(1);
      expect(builders[0]!.text).toContain("# Your job");
      expect(builders[1]!.text).toContain("You may now use the screen for");
      expectShortContinues(builders.slice(2));
      expect(run.fakes.opens().filter((entry) => entry.session === builders[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume", "resume"]);
      expect(run.modelOf(builders[5]!.session)).toBe("gpt-6.1-sol");
      expect(run.effortOf(builders[5]!.session)).toBe("xhigh");
      assertNotAccountLimit(run, task);
    } finally { await run.engine.shutdown(); }
  });

  it("reopens both reviewers' conversations when they fill up together", async () => {
    const run = await start({
      planner: "two-codex",
      builder: "plain",
      reopen: "resume",
      capacity: [
        { model: "gpt-6.1-sol", role: "code reviewer", times: 1 },
        { model: "gpt-6-astra", role: "code reviewer", times: 1 },
      ],
    }, { before: onlyCodex });
    try {
      const waiting = await capacityWait(run, 5_000, ["gpt-6.1-sol", "gpt-6-astra"]);
      expect(live(run).capacityResume).toHaveLength(2);
      expect(live(run).capacityRetries?.filter((entry) => entry.roleId === "code-reviewer" && entry.tried === 1)).toHaveLength(2);
      expect(roundOf(waiting, "code-reviewer")).toBe(1);
      await releaseCapacity(run.engine, run.taskId, ["gpt-6.1-sol", "gpt-6-astra"]);
      const task = await run.done();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
      const reviewers = run.fakes.received("code reviewer");
      const sessions = [...new Set(reviewers.map((entry) => entry.session))];
      expect(sessions).toHaveLength(2);
      for (const session of sessions) {
        const prompts = reviewers.filter((entry) => entry.session === session);
        expect(prompts).toHaveLength(2);
        expect(prompts[0]!.text).toContain("# Your job");
        expectShortContinues(prompts.slice(1));
        expect(run.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      }
      expect(sessions.map((session) => run.modelOf(session)).sort()).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    } finally { await run.engine.shutdown(); }
  });

  it("gives a replacement model its own short retries before another tool takes the step", async () => {
    const run = await start({
      planner: "short",
      builder: "plain",
      reopen: "resume",
      capacity: [
        { model: "gpt-6.1-sol", role: "builder", times: 4 },
        { model: "gpt-6-astra", role: "builder", times: 1 },
      ],
    });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      await capacityWait(run, 5_000, "gpt-6-astra");
      expect(live(run).capacityRetries?.some((entry) => entry.modelId === "gpt-6-astra" && entry.tried === 1)).toBe(true);
      expect(live(run).capacityPaused?.some((entry) => entry.profileId === "astra-xhigh" && entry.plannedId === "sol-xhigh")).toBe(true);
      expect(run.fakes.received("builder").every((entry) => run.modelOf(entry.session) === "gpt-6.1-sol" || run.modelOf(entry.session) === "gpt-6-astra")).toBe(true);
      await releaseCapacity(run.engine, run.taskId, "gpt-6-astra");
      const task = await run.done();
      assertNotAccountLimit(run, task);
      const builders = run.fakes.received("builder");
      expect(builders.every((entry) => run.modelOf(entry.session) === "gpt-6.1-sol" || run.modelOf(entry.session) === "gpt-6-astra")).toBe(true);
      const sol = builders.filter((entry) => run.modelOf(entry.session) === "gpt-6.1-sol");
      const astra = builders.filter((entry) => run.modelOf(entry.session) === "gpt-6-astra");
      expect(sol).toHaveLength(4);
      expectShortContinues(sol.slice(1));
      expect(astra).toHaveLength(2);
      expect(new Set(astra.map((entry) => entry.session)).size).toBe(1);
      expect(astra[0]!.text).toContain("could not continue (the selected model is at capacity)");
      expectShortContinues(astra.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === astra[0]!.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
    } finally { await run.engine.shutdown(); }
  });

  it("still records a real usage limit as the account running out", async () => {
    const run = await start({ planner: "short", builder: "plain", limited: [{ model: "gpt-6.1-sol", role: "builder" }] });
    try {
      const task = await run.done();
      expect(run.engine.getState().pool.limited?.some((entry) => entry.toolId === "codex")).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("ran out of usage"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("at capacity"))).toBe(false);
      expect(usageLines(run.engine.getState(), Date.now()).find((line) => line.toolId === "codex")?.tone).toBe("out");
    } finally { await run.engine.shutdown(); }
  });
});

/** Grok's own retry notice for a lost connection, as its recorded conversations carry it. */
const grokLostConnection: NativeStep = { notice: { method: "_x.ai/session/update", params: { update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason: "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (Connect): dns error: failed to lookup address information", error_type: "http" } } } };

describe.concurrent("a Claude Code or Grok model that is at capacity", () => {
  it("retries Claude's own conversation after its explicit overload, then continues the step on another model", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", reopen: "resume", capacity: [{ model: "opus", role: "builder", shape: "claude", times: 4 }] });
    try {
      await sameModelWaits(run, SHORT_WAITS, "opus");
      const task = await run.done();
      assertNotAccountLimit(run, task, "claude-code");
      expect(task.timeline.some((entry) => entry.text.includes("stopped because the selected model is at capacity"))).toBe(true);
      const builders = run.fakes.received("builder");
      const first = builders[0]!;
      const same = builders.filter((entry) => entry.session === first.session);
      const next = builders.find((entry) => entry.session !== first.session)!;
      expect(same).toHaveLength(4);
      expect(same[0]!.text).toContain("# Your job");
      expectShortContinues(same.slice(1));
      expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume", "resume", "resume"]);
      expect(run.modelOf(first.session)).toBe("opus");
      expect(run.modelOf(next.session)).not.toBe("opus");
      expect(next.text).toContain("could not continue (the selected model is at capacity)");
      expect(roundOf(task, "code-reviewer")).toBe(1);
    } finally { await run.engine.shutdown(); }
  });

  it("retries Grok's conversation after a mid-turn overload, keeps its draft, and does not bring back a replayed reconnect", async () => {
    const run = await start({
      planner: "grok-build", builder: "plain", reopen: "load",
      // Grok lost its connection and recovered by itself earlier in the same turn. That does not explain the stop.
      nativeRetry: [{ role: "builder", model: "grok-4.7", steps: [grokLostConnection, { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Back on the greeting." } } }] }],
      capacity: [{ model: "grok-4.7", role: "builder", shape: "grok", partial: true }],
    });
    try {
      const waiting = await capacityWait(run, 5_000, "grok-4.7");
      expect(readFileSync(join(waiting.worktree!, "capacity-draft.txt"), "utf8")).toBe("A greeting draft\n");
      expect(waiting.session.some((line) => line.from === "agent" && line.text.includes("I drafted the greeting before the model filled up."))).toBe(true);
      expect(waiting.retrying).toBeUndefined();
      await releaseCapacity(run.engine, run.taskId, "grok-4.7");
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(2);
      expect(builders.every((entry) => entry.session === builders[0]!.session)).toBe(true);
      expect(run.fakes.opens().filter((entry) => entry.session === builders[0]!.session).map((entry) => entry.how)).toEqual(["new", "load"]);
      expectShortContinues(builders.slice(1));
      // One line for the live notice. Reopening replays it as history, and it does not come back.
      expect(task.timeline.filter((entry) => entry.text.includes("Reconnecting to Grok")).length).toBe(1);
      expect(task.retrying).toBeUndefined();
      assertNotAccountLimit(run, task, "grok");
      expect(roundOf(task, "code-reviewer")).toBe(1);
    } finally { await run.engine.shutdown(); }
  });

  it("waits about five minutes after Grok's short retries when no other tool can take the step", async () => {
    const run = await start({ planner: "grok-build", builder: "plain", reopen: "load", capacity: [{ model: "grok-4.7", role: "builder", shape: "grok", times: 4 }] }, {
      before: (engine) => { engine.s.setup!.checks = [{ id: "claude-code", status: "logged-out" }, { id: "codex", status: "logged-out" }, { id: "grok", status: "ready" }, { id: "antigravity", status: "logged-out" }]; },
    });
    try {
      await sameModelWaits(run, SHORT_WAITS, "grok-4.7");
      const waiting = await capacityWait(run, 5 * 60_000, "grok-4.7");
      expect(waiting.statusLine).not.toContain("Waiting for usage");
      const session = run.fakes.received("builder")[0]!.session;
      expect(waiting.conversation?.sessionId).toBe(session);
      assertNotAccountLimit(run, waiting, "grok");
      await releaseCapacity(run.engine, run.taskId, "grok-4.7");
      // The review needs another tool; it starts once one is ready again.
      run.engine.s.setup!.checks = run.engine.s.setup!.checks.map((check) => ({ ...check, status: "ready" as const }));
      const task = await run.done();
      const builders = run.fakes.received("builder");
      expect(builders).toHaveLength(5);
      expect(builders.every((entry) => entry.session === session)).toBe(true);
      expectShortContinues(builders.slice(1));
      expect(roundOf(task, "code-reviewer")).toBe(1);
      assertNotAccountLimit(run, task, "grok");
    } finally { await run.engine.shutdown(); }
  });
});

describe("a scheduled run whose model is at capacity", () => {
  it("waits and retries the saved profile, and leaves the working copy unchanged", async () => {
    const world = await makeWorld("capacity-maintenance");
    roots.push(world.dir);
    const fakes = new Fakes(join(world.dir, "agents"));
    fakes.scenario({ maintenance: {}, reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "bug finder", times: 4 }] });
    const engine = world.start({ agentCommand: (profile) => [process.execPath, FAKE_AGENT, fakes.dir, `--record-tool=${profile.toolId}`], toolPath: () => process.execPath });
    const stops = holdCapacityWaits(engine);
    engine.setPoolPaused(true);
    try {
      const productId = await engine.addProduct(world.clone);
      engine.setProductChecks(productId, [{ name: "Tests", command: `${process.execPath} -e 'process.exit(0)'` }]);
      const draft: RoutineDraft = { name: "Focused maintenance", productId, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Inspect checkout behavior", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true };
      const routineId = engine.saveRoutine(draft);
      const due = engine.getState().routines!.find((routine) => routine.id === routineId)!.nextAt;
      engine.pollRoutines(due);
      const taskId = engine.getState().routines!.find((routine) => routine.id === routineId)!.latestTaskId!;
      engine.setPoolPaused(false);
      const run: Held = { engine, taskId, stops, read: () => engine.taskDetails(taskId) };
      for (const [index, delay] of SHORT_WAITS.entries()) {
        const waiting = await capacityWait(run, delay, "gpt-6.1-sol", index + 1);
        expect(waiting.maintenance?.profile.id).toBe("sol-medium");
        const waitingHead = await git(waiting.worktree!, "rev-parse", "HEAD");
        expect(waiting.baseSha).toBe(waitingHead);
        expect(await git(waiting.worktree!, "status", "--porcelain")).toBe("");
        await releaseCapacity(engine, taskId);
      }
      const held = await capacityWait(run, 5 * 60_000);
      expect(held.maintenance?.profile.id).toBe("sol-medium");
      expect(await git(held.worktree!, "status", "--porcelain")).toBe("");
      expect(engine.getState().pool.limited ?? []).toEqual([]);
      expect(fakes.received("bug finder").every((entry) => fakes.settings(entry.session).includes("model=gpt-6.1-sol"))).toBe(true);
      expect(engine.s.tasks.find((task) => task.id === taskId)?.capacityRetries?.some((entry) => entry.tried === 3)).toBe(true);
      await releaseCapacity(engine, taskId);
      const task = await waitFor(() => {
        const current = engine.taskDetails(taskId);
        if (current?.state === "failed") throw new Error(current.error);
        return current?.state === "done" && current;
      }, "the scheduled run to finish", 60_000);
      const prompts = fakes.received("bug finder");
      expect(prompts).toHaveLength(5);
      expect(new Set(prompts.map((entry) => entry.session)).size).toBe(1);
      expectShortContinues(prompts.slice(1));
      expect(fakes.settings(prompts[4]!.session)).toContain("model=gpt-6.1-sol");
      // The engine compares the tree after the retry. Cleanup may already have removed the copy.
      expect(task.maintenance?.noProductChanges).toBe(true);
      expect(engine.getState().pool.limited ?? []).toEqual([]);
      expect(task.timeline.some((line) => line.text.includes("ran out of usage"))).toBe(false);
    } finally { await engine.shutdown(); }
  });
});

describe("telling a full model from an account limit", () => {
  const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" };

  it("matches only a turn that ends on the capacity sentence", () => {
    expect(codexModelAtCapacity(`\n${SENTENCE}`)).toBe(true);
    expect(codexModelAtCapacity(`${SENTENCE}\n`)).toBe(true);
    expect(codexModelAtCapacity(`A note along the way said “${SENTENCE}” The work is finished.`)).toBe(false);
  });

  it("leaves usage, rate and session limits on the account, and a full model off it", () => {
    const now = Date.now();
    expect(limitFromFailure(codex, { message: SENTENCE, data: { message: SENTENCE } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "serverOverloaded" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codex_error_info: "server_overloaded" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "usageLimitExceeded" } }, "", now)?.reason).toBe("Codex's usage limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "rateLimitExceeded" } }, "", now)?.reason).toBe("Codex's rate limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "sessionBudgetExceeded" } }, "", now)?.reason).toBe("Codex's usage limit");
    expect(limitFromFailure(codex, { data: { codexErrorInfo: "contextWindowExceeded" } }, "", now)).toBeUndefined();
    expect(failureReason(new WaitingForCapacity("The selected model is at capacity"))).toBe("other");
    expect(failureReason(new ModelAtCapacity("codex", "gpt-6.1-sol", "sol-xhigh"))).toBe("other");
    expect(failureReason(new WaitingForUsage("Waiting for usage"))).toBe("limit");
  });

  it("retries the same conversation on a short schedule, and reads Codex's overloaded stop", () => {
    expect(capacityRetryDelay(0)).toBe(5_000);
    expect(capacityRetryDelay(1)).toBe(10_000);
    expect(capacityRetryDelay(2)).toBe(30_000);
    expect(capacityRetryDelay(3)).toBeUndefined();
    expect(capacityRetryDelay(0, 45_000)).toBe(45_000);
    expect(capacityRetryDelay(2, 1_000)).toBe(30_000);
    const failure = { _meta: { jetbrains: { air: { sessionFailure: { severity: "error", category: "service", title: SENTENCE, actions: ["retry"] } } } } };
    const warning = { _meta: { jetbrains: { air: { sessionFailure: { severity: "warning", title: SENTENCE, actions: ["retry"] } } } } };
    expect(codexCapacityFailure({ data: { codexErrorInfo: "serverOverloaded" } })).toEqual({});
    expect(codexCapacityFailure({ data: { codex_error_info: "server_overloaded" } })).toEqual({});
    expect(codexCapacityFailure({ data: { codexErrorInfo: "usageLimitExceeded" } })).toBeUndefined();
    expect(codexCapacityFailure({ data: { codexErrorInfo: "serverOverloaded", retryAfterMs: 45_000 } })).toEqual({ retryAfterMs: 45_000 });
    expect(codexCapacityFailure({ data: { message: SENTENCE, retry_after_seconds: 12 } })).toEqual({ retryAfterMs: 12_000 });
    expect(codexCapacityFailure({ data: { message: SENTENCE, retryAfter: 5_000 } })).toEqual({});
    expect(codexCapacityFailure(failure)).toEqual({});
    expect(codexCapacityFailure(warning)).toBeUndefined();
  });
});

describe("choosing who continues after a model fills up", () => {
  function choiceEngine() {
    const root = tempDir("petrina-capacity-choice-");
    roots.push(root);
    const engine = new Engine(root, { agentCommand: () => ["unused"], toolPath: () => process.execPath });
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "product", name: "Product", repo: "a/b", tone: "blue", delivery: "local", approveDelivery: true });
    engine.s.setup!.checks = ["claude-code", "codex", "grok", "antigravity"].map((id) => ({ id: id as "codex", status: "ready" as const }));
    const id = engine.addTask({ productId: "product", title: "Build" });
    const task = engine.s.tasks.find((entry) => entry.id === id)!;
    engine.s.pool.paused = false;
    const room = (toolId: string) => !slotWait(engine.getState(), { taskId: id, toolId });
    const profileOf = (planned: string, role: string, reviewerKey?: string) => {
      const choice = engine.choose(planned, task, role, room, reviewerKey);
      return choice?.kind === "none" ? undefined : choice?.profile;
    };
    return { engine, task, profileOf };
  }

  it("uses a free tool when the preferred tool has no seat, and keeps a review off the builder's tool", async () => {
    const { engine, task, profileOf } = choiceEngine();
    const soon = Date.now() + 60_000;
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");
      engine.s.pool.toolCaps["codex"] = 0;
      expect(profileOf("sol-xhigh", "builder")?.toolId).toBe("claude-code");
      delete task.modelCapacity;
      engine.s.pool.toolCaps["codex"] = 3;
      engine.s.pool.limited = [{ toolId: "codex", until: soon, reason: "Codex is out" }];
      expect(profileOf("sol-xhigh", "builder")?.toolId).toBe("claude-code");
      engine.s.pool.limited = [];
      engine.s.pool.toolCaps["codex"] = 0;
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      task.plan = { rationale: "Review", plannerProfileId: "opus-high", stages: [
        { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "opus-high"] },
      ] };
      expect(profileOf("sol-xhigh", "code-reviewer", "0")?.id).toBe("astra-xhigh");

      engine.s.pool.toolCaps["codex"] = 3;
      engine.s.setup!.checks = ["claude-code", "codex", "grok", "antigravity"].map((id) => ({ id: id as "codex", status: "ready" as const }));
      task.stageIndex = 1;
      task.plan = { rationale: "Build", plannerProfileId: "opus-high", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
        { id: "security", kind: "review-chain", title: "Security", roleId: "security-reviewer", profileIds: ["opus-xhigh"] },
      ] };
      executionFor(task).work.builderSession = { stageId: "build", profileId: "opus-xhigh", toolId: "claude-code", model: "opus", sessionId: "saved" };
      expect(profileOf("opus-xhigh", "security-reviewer")?.toolId).not.toBe("claude-code");
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      expect(profileOf("opus-xhigh", "security-reviewer")?.toolId).not.toBe("claude-code");
    } finally { await engine.shutdown(); }
  });

  it("continues a replacement's conversation only when it has a seat and usage, and stays off the builder's tool", async () => {
    const { engine, task, profileOf } = choiceEngine();
    const later = Date.now() + 5 * 60_000;
    const hours = Date.now() + 5 * 60 * 60_000;
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      // The first Codex model is still full. The second one took over, filled up too, and is owed its short continue.
      const owe = (roleId: string, member?: string) => {
        task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later }];
        task.capacityResume = [{ sessionId: "astra-session", profileId: "astra-xhigh", roleId, toolId: "codex", model: "gpt-6-astra", ...(member ? { member } : {}) }];
        task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId, tried: 1, ...(member ? { member } : {}) }];
      };
      for (const [roleId, key, member] of [["builder", undefined, undefined], ["code-reviewer", "0", "review-0"]] as const) {
        owe(roleId, member);
        expect(profileOf("sol-xhigh", roleId, key)?.id).toBe("astra-xhigh");
        // No free Codex seat: a free tool takes the step instead of waiting for Codex.
        engine.s.pool.toolCaps["codex"] = 0;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        delete task.capacityResume;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        engine.s.pool.toolCaps["codex"] = 3;
        // Codex is out of account usage for hours: the existing stand-in still takes the step.
        owe(roleId, member);
        engine.s.pool.limited = [{ toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        delete task.capacityResume;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        engine.s.pool.limited = [];
      }

      // A security review stays off the builder's tool even when its own conversation there is owed a continue.
      task.stageIndex = 1;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { id: "security", kind: "review-chain", title: "Security", roleId: "security-reviewer", profileIds: ["sol-xhigh"] },
      ] };
      executionFor(task).work.builderSession = { stageId: "build", profileId: "astra-xhigh", toolId: "codex", model: "gpt-6-astra", sessionId: "built" };
      owe("security-reviewer");
      expect(profileOf("sol-xhigh", "security-reviewer")?.toolId).toBe("claude-code");
    } finally { await engine.shutdown(); }
  });

  it("waits for the account, not the full model, when the account is out too", async () => {
    const { engine, task } = choiceEngine();
    const later = Date.now() + 5 * 60_000;
    const hours = Date.now() + 5 * 60 * 60_000;
    const capacityWait = (choice: ReturnType<Engine["choose"]>) => choice?.kind === "none" && choice.waiting.startsWith("The selected model is at capacity");
    const usageWait = (choice: ReturnType<Engine["choose"]>) => choice?.kind === "none" && choice.waiting.startsWith("Waiting for usage");
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      const codexModels = [...new Set(engine.s.profiles.filter((profile) => profile.toolId === "codex").map((profile) => profile.modelId ?? profile.model))];
      const allFull = () => codexModels.map((modelId) => ({ toolId: "codex", modelId, profileId: "sol-xhigh", until: later }));
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      // Every Codex model is full and Claude is out: the task waits for the full model.
      task.modelCapacity = allFull();
      engine.s.pool.limited = [{ toolId: "claude-code", until: hours, reason: "Claude's weekly limit" }];
      expect(capacityWait(engine.choose("sol-xhigh", task, "builder"))).toBe(true);
      // Codex's account is out as well: the wait is the account limit's.
      engine.s.pool.limited = [...engine.s.pool.limited, { toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
      expect(usageWait(engine.choose("sol-xhigh", task, "builder"))).toBe(true);

      // A voter keeps its seat for a full model, but not for an account limit.
      engine.s.pool.limited = [];
      expect(capacityWait(engine.choose("sol-high", task, "verifier"))).toBe(true);
      engine.s.pool.limited = [{ toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
      expect(capacityWait(engine.choose("sol-high", task, "verifier"))).toBe(false);

      // A scheduled run waits for its saved profile's account the same way.
      const sol = engine.s.profiles.find((profile) => profile.id === "sol-xhigh")!;
      (task as { maintenance?: unknown }).maintenance = { role: engine.s.roles.find((role) => role.id === "maintenance-bug-finder"), profile: sol };
      expect(engine.choose("sol-xhigh", task, "maintenance-bug-finder")).toEqual({ kind: "none", waiting: "Waiting for usage on the saved maintenance profile" });
      engine.s.pool.limited = [];
      expect(capacityWait(engine.choose("sol-xhigh", task, "maintenance-bug-finder"))).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it("holds a replacement's own short retry, and not a different step", async () => {
    const { engine, task, profileOf } = choiceEngine();
    const now = Date.now();
    const soon = now + 5_000;
    const later = now + 5 * 60_000;
    try {
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      task.modelCapacity = [
        { toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later },
        { toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", until: soon },
      ];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "sol-xhigh" }];
      expect(engine.choose("sol-xhigh", task, "builder")).toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });
      expect(engine.choose("astra-xhigh", task, "builder")).toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });
      expect(engine.choose("sol-xhigh", task, "code-reviewer")).not.toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });

      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", until: soon }];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "astra-xhigh" }];
      expect(engine.choose("astra-xhigh", task, "builder")?.kind).toBe("none");
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("sol-xhigh");

      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later }];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "sol-xhigh" }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");

      // Both waits have ended, so the pause is gone and the original model is free. The replacement's saved conversation still goes on.
      delete task.modelCapacity;
      delete task.capacityPaused;
      task.capacityResume = [{ sessionId: "astra-session", profileId: "astra-xhigh", roleId: "builder", toolId: "codex", model: "gpt-6-astra" }];
      task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", tried: 1 }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");
      expect(profileOf("sol-xhigh", "code-reviewer")?.id).not.toBe("astra-xhigh");
      delete task.capacityResume;
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("sol-xhigh");

      task.capacityResume = [
        { sessionId: "review-astra", profileId: "astra-xhigh", roleId: "code-reviewer", toolId: "codex", model: "gpt-6-astra", member: "review-0" },
        { sessionId: "review-opus", profileId: "opus-high", roleId: "code-reviewer", toolId: "claude-code", model: "opus", member: "review-1" },
      ];
      task.capacityRetries = [
        { toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "code-reviewer", member: "review-0", tried: 1 },
        { toolId: "claude-code", modelId: "opus", profileId: "opus-high", roleId: "code-reviewer", member: "review-1", tried: 1 },
      ];
      expect(profileOf("sol-xhigh", "code-reviewer", "0")?.id).toBe("astra-xhigh");
      expect(profileOf("opus-high", "code-reviewer", "1")?.id).toBe("opus-high");
      task.capacityResume = [{ sessionId: "vote-astra", profileId: "astra-xhigh", roleId: "verifier", toolId: "codex", model: "gpt-6-astra", member: "vote-sol-high" }];
      task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "verifier", member: "vote-sol-high", tried: 1 }];
      expect(profileOf("sol-high", "verifier")?.id).toBe("astra-xhigh");
      expect(profileOf("opus-high", "verifier")?.id).toBe("opus-high");
    } finally { await engine.shutdown(); }
  });
});
