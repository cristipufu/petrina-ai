import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { localFixtureSource, screenFixturePlan } from "../../fixtures/prepared-runtime.js";
import { executionFor } from "@petrina/orchestrator";
import { rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandInputText, usageLines, type RoutineDraft, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";


import { CAPACITY_WAIT } from "@petrina/agent-runtime/failures";
import { MODEL_CAPACITY_WAIT_MS } from "../../../src/usage.js";
import { CODEX_MODEL_CAPACITY } from "@petrina/agent-runtime/provider-interruptions";

import type { NativeStep, Scenario } from "../../fake-agent.js";
import { Fakes, FAKE_AGENT, git, makeProduct, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
const fixtures = new Set<ReturnType<typeof directDrivers>>();
afterAll(async () => { await closeDirectDrivers(fixtures); fixtures.clear(); roots.forEach(removeFixtureRoot); });

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

/** Only the native stage's immutable role/profile inputs; no completed work or execution evidence. */
interface PreparedCapacityPlan {
  readonly builderProfileId: string;
  readonly reviewerProfileIds: readonly string[];
  readonly reviewMaxRounds: 1;
}

/** One task on fake agents, delivering locally, with every tool counted as installed. */
async function start(scenario: Scenario, options: { description?: string; before?: (engine: Engine) => void; focus?: "builder" | "review"; preparedPlan?: PreparedCapacityPlan } = {}) {
  const root = tempDir("petrina-capacity-");
  roots.push(root);
  const lifetime = directDrivers(root); fixtures.add(lifetime);
  const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
  return setupWithCleanup(async () => {
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = lifetime.open(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], toolPath: () => process.execPath });
  const stops = holdCapacityWaits(engine);
  if (options.focus) engine.setPoolPaused(true);
  options.before?.(engine);
  return lifetime.prepare(async () => {
  const productId = await engine.addProduct(await makeProduct(root));
  engine.setProductDelivery(productId, "local", false);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: options.description ?? "[no-check]", ...(options.focus ? { backlog: true } : {}) });
  if (options.focus) {
    const task = engine.task(taskId)!;
    await localFixtureSource(engine, task);
    const profiles = options.preparedPlan ? [...options.preparedPlan.reviewerProfileIds]
      : scenario.planner === "parallel" ? ["opus-high", "sol-high"] : ["opus-high"];
    task.plan = { rationale: "Focused native capacity stage; the private repository remains real", plannerProfileId: "sol-xhigh", stages: screenFixturePlan(profiles) };
    if (scenario.planner === "grok-build") task.plan.stages[0]!.profileIds = ["grok-xhigh"];
    if (options.preparedPlan) {
      task.plan.stages[0]!.profileIds = [options.preparedPlan.builderProfileId];
      task.plan.stages[1]!.maxRounds = options.preparedPlan.reviewMaxRounds;
    }
    task.approvePlan = false; task.approveDelivery = true;
    task.risk = { level: "low", why: "Private greeting fixture" };
    task.stageIndex = options.focus === "review" ? 1 : 0;
    if (options.focus === "review") {
      const work = executionFor(task).work, product = engine.s.products.find(product => product.id === productId)!;
      const base = await git(product.path!, "rev-parse", "HEAD"), worktree = join(root, "capacity-work");
      await git(product.path!, "worktree", "add", "-q", "-b", "capacity-target", worktree, base);
      writeFileSync(join(worktree, "greeting.txt"), "Hello from the actual private review fixture\n");
      await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the greeting under review");
      Object.assign(work, { worktree, branch: "capacity-target", baseSha: base, base, preparation: "ready" });
    }
    engine.queueTask(taskId); engine.setPoolPaused(false);
  }
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
      // Focused cases stop only after a real completed review at the existing delivery decision.
      if (options.focus) return task.state === "needs-you" && engine.s.inbox.some(item => item.taskId === taskId && item.kind === "delivery")
        && task.journey?.some(step => step.kind === "agent" && step.roleId === "code-reviewer" && step.endedAt !== undefined) && task;
      return task.state === "done" && task;
    }, "the task to finish", TASK_MS);
  const modelOf = (session: string) => fakes.settings(session).find((line) => line.startsWith("model="))?.slice("model=".length);
  const effortOf = (session: string) => {
    const line = fakes.settings(session).find((entry) => entry.startsWith("effort=") || entry.startsWith("reasoning_effort="));
    return line?.slice(line.indexOf("=") + 1);
  };
  return { root, engine, fakes, find, read, done, answer, modelOf, effortOf, taskId, stops, close };
  });
  }, close);
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
      const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [capacity] }, { focus: "builder" });
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
      } finally { await run.close(); }
    });
  }

  it("waits about five minutes after the short retries when nothing else can take the step", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", times: 4 }] }, { before: onlySol, focus: "builder" });
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
    } finally { await run.close(); }
  });

  it("keeps a draft while it waits, then continues in the same conversation", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", partial: true }] }, { before: onlySol, focus: "builder" });
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
    } finally { await run.close(); }
  });

  it("continues on another tool after the short retries when no other Codex model is free", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", partial: true, times: 4 }] }, {
      before: (engine) => { engine.s.profiles = engine.s.profiles.filter((profile) => profile.modelId !== "gpt-6-astra"); },
      focus: "builder",
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
    } finally { await run.close(); }
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
    } finally { await run.close(); }
  });

  it("honors a provider retry delay before continuing the same conversation", async () => {
    const run = await start({ planner: "short", builder: "plain", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", thrown: true, retryAfterMs: 45_000 }] }, { focus: "builder" });
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
    } finally { await run.close(); }
  });

  it("accepts a finished result that only mentions the sentence", async () => {
    const run = await start({ planner: "short", builder: "plain", mentionCapacity: true }, { focus: "builder" });
    try {
      const task = await run.done();
      expect(run.fakes.received("builder")).toHaveLength(1);
      expect(task.timeline.some((entry) => entry.text.includes("at capacity"))).toBe(false);
      expect(live(run).modelCapacity).toBeUndefined();
      assertNotAccountLimit(run, task);
      expect(roundOf(task, "code-reviewer")).toBe(1);
    } finally { await run.close(); }
  });

  it("keeps the other reviewer's result and does not spend a review round", async () => {
    // The reviewer on Opus keeps working until the test lets it finish, so the full model's first wait starts and ends beside it.
    const run = await start({
      planner: "parallel",
      builder: "plain",
      reopen: "resume",
      capacity: [{ model: "gpt-6.1-sol", role: "code reviewer", partial: true, times: 4 }],
      nativeRetry: [{ role: "code reviewer", model: "opus", steps: [{ mark: "opus-reviewing" }, { wait: "opus-may-finish" }] }],
    }, { focus: "review", preparedPlan: { builderProfileId: "sol-xhigh", reviewerProfileIds: ["opus-high", "sol-high"], reviewMaxRounds: 1 } });
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
    } finally { await run.close(); }
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
    } finally { await run.close(); }
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
    }, { focus: "review" });
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
    } finally { await run.close(); }
  });

  it("keeps a Codex vote on another Codex model after the short retries", async () => {
    const run = await start({ planner: "short", builder: "plain", reviewer: "important", verifier: "not-a-bug", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "verifier", times: 4 }, { model: "gpt-6-astra", role: "verifier", times: 1 }] }, { focus: "review" });
    try {
      await sameModelWaits(run, SHORT_WAITS);
      await capacityWait(run, 5_000, "gpt-6-astra", 1);
      const hunt = live(run).hunt!, place = hunt.panel!.seats.find(seat => seat.toolId === "codex")!;
      const replacement = run.fakes.received("verifier").find(entry => run.modelOf(entry.session) === "gpt-6-astra")!;
      const versions = structuredClone(hunt.input!.heads);
      expect(live(run).capacityResume?.find(entry => entry.profileId === "astra-xhigh")).toMatchObject({ sessionId: replacement.session, member: `vote-${place.key}` });
      expect(run.modelOf(replacement.session)).toBe("gpt-6-astra");
      expect(run.effortOf(replacement.session)).toBe(run.engine.profile("astra-xhigh")!.effort);
      await releaseCapacity(run.engine, run.taskId, "gpt-6-astra");
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
      const astra = verifiers.filter(entry => run.modelOf(entry.session) === "gpt-6-astra");
      expect(astra).toHaveLength(2);
      expect(astra.map(entry => entry.session)).toEqual([replacement.session, replacement.session]);
      expect(astra[0]!.text).toContain("could not continue (the selected model is at capacity)");
      expectShortContinues(astra.slice(1));
      expect(run.fakes.opens().filter(entry => entry.session === replacement.session).map(entry => entry.how)).toEqual(["new", "resume"]);
      const inputs = task.journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.sessionId === replacement.session);
      expect(inputs.map(input => input.mode)).toEqual(["fresh", "continued"]);
      expect(inputs.map(input => input.confirmedSettings)).toEqual([
        expect.objectContaining({ model: "gpt-6-astra", effort: run.engine.profile("astra-xhigh")!.effort }),
        expect.objectContaining({ model: "gpt-6-astra", effort: run.engine.profile("astra-xhigh")!.effort }),
      ]);
      expect(votes.find(vote => vote.by === "astra-xhigh")).toMatchObject({ plannedProfileId: "sol-high", ballot: { seat: place.key, round: hunt.round, versions } });
    } finally { await run.close(); }
  });

  it("retries the same profile when the agent already has the screen", async () => {
    const run = await start({ planner: "short", builder: "plain", screen: "ask", reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "builder", onScreen: true, times: 4 }] }, {
      before: (engine) => engine.setScreenUse("on"), focus: "builder",
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
    } finally { await run.close(); }
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
    }, { before: onlyCodex, focus: "review", preparedPlan: { builderProfileId: "sol-xhigh", reviewerProfileIds: ["sol-high", "astra-xhigh"], reviewMaxRounds: 1 } });
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
    } finally { await run.close(); }
  });

  it("still records a real usage limit as the account running out", async () => {
    const run = await start({ planner: "short", builder: "plain", limited: [{ model: "gpt-6.1-sol", role: "builder" }] }, { focus: "builder" });
    try {
      const task = await run.done();
      expect(run.engine.getState().pool.limited?.some((entry) => entry.toolId === "codex")).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("ran out of usage"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("at capacity"))).toBe(false);
      expect(usageLines(run.engine.getState(), Date.now()).find((line) => line.toolId === "codex")?.tone).toBe("out");
    } finally { await run.close(); }
  });
});

/** Grok's own retry notice for a lost connection, as its recorded conversations carry it. */
const grokLostConnection: NativeStep = { notice: { method: "_x.ai/session/update", params: { update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason: "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (Connect): dns error: failed to lookup address information", error_type: "http" } } } };

describe.concurrent("a Claude Code or Grok model that is at capacity", () => {
  it("retries Claude's own conversation after its explicit overload, then continues the step on another model", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", reopen: "resume", capacity: [{ model: "opus", role: "builder", shape: "claude", times: 4 }] }, {
      focus: "builder", preparedPlan: { builderProfileId: "opus-high", reviewerProfileIds: ["sol-high"], reviewMaxRounds: 1 },
    });
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
    } finally { await run.close(); }
  });

  it("retries Grok's conversation after a mid-turn overload, keeps its draft, and does not bring back a replayed reconnect", async () => {
    const run = await start({
      planner: "grok-build", builder: "plain", reopen: "load",
      // Grok lost its connection and recovered by itself earlier in the same turn. That does not explain the stop.
      nativeRetry: [{ role: "builder", model: "grok-4.7", steps: [grokLostConnection, { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Back on the greeting." } } }] }],
      capacity: [{ model: "grok-4.7", role: "builder", shape: "grok", partial: true }],
    }, { focus: "builder" });
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
    } finally { await run.close(); }
  });

  it("waits about five minutes after Grok's short retries when no other tool can take the step", async () => {
    const run = await start({ planner: "grok-build", builder: "plain", reopen: "load", capacity: [{ model: "grok-4.7", role: "builder", shape: "grok", times: 4 }] }, {
      before: (engine) => { engine.s.setup!.checks = [{ id: "claude-code", status: "logged-out" }, { id: "codex", status: "logged-out" }, { id: "grok", status: "ready" }, { id: "antigravity", status: "logged-out" }]; },
      focus: "builder" });
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
    } finally { await run.close(); }
  });
});

describe("a scheduled run whose model is at capacity", () => {
  it("waits and retries the saved profile, and leaves the working copy unchanged", async () => {
    const root = tempDir("petrina-capacity-maintenance-"); roots.push(root);
    const lifetime = directDrivers(root); fixtures.add(lifetime);
    const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
    const { engine, fakes, stops, clone } = await setupWithCleanup(() => lifetime.prepare(async () => {
      const fakes = new Fakes(join(root, "agents"));
      fakes.scenario({ maintenance: {}, reopen: "resume", capacity: [{ model: "gpt-6.1-sol", role: "bug finder", times: 4 }] });
      const engine = lifetime.open(join(root, "data"), { agentCommand: (profile) => [process.execPath, FAKE_AGENT, fakes.dir, `--record-tool=${profile.toolId}`], toolPath: () => process.execPath });
      const stops = holdCapacityWaits(engine);
      engine.setPoolPaused(true);
      const clone = await makeProduct(root);
      return { engine, fakes, stops, clone };
    }), close);
    try {
      const productId = await engine.addProduct(clone);
      engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }]);
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
    } finally { await close(); }
  });
});

for (const failure of [undefined, new Error("Controlled native setup failure")]) it(`owns failed capacity setup even when its rejection is ${failure === undefined ? "undefined" : "an Error"}`, async () => {
  let failedRoot: string | undefined;
  expect(await rejectionOf(start({}, { before(engine) { failedRoot = dirname(engine.dataDir); throw failure; } }))).toBe(failure);
  expect(failedRoot).toBeDefined();
  expect(existsSync(failedRoot!)).toBe(false);
});
