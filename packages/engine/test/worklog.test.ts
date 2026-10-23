import { expectRejection } from "./rejections.js";
// The work log, end to end: a real engine with the fake agent reporting usage and settings the
// way Claude Code and Codex do, and the product list that never hands an id out again.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State, Task, WorkTurn } from "@petrina/core";
import type { Kernel, MStage, MTask } from "../src/kernel.js";
import { Tracking } from "../src/tracking.js";
import { AgentRun, reportOf } from "../src/acp-run.js";
import { Engine } from "./engine.js";
import { dispatch } from "../src/server.js";
import { Store } from "../src/store.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { WaitClock, WorkLog } from "../src/worklog.js";
import { git, removeDir, SLOW, testBrowserRoot } from "./fixtures.js";

const fake = join(import.meta.dir, "fake-agent.ts");
const fakeCodex = join(import.meta.dir, "fake-codex.ts");
const temp = mkdtempSync(join(tmpdir(), "petrina-worklog-"));
const data = join(temp, "data");
// Each profile's agent behaves like its own tool: Claude Code or Codex.
const options = { agentCommand: (profile: { toolId: string }) => [process.execPath, fake, `--tool=${profile.toolId}`], usageCommands: { codex: [process.execPath, fakeCodex] } };

// Conversations started here keep their browsers, in this file's own browser folder.
const browsers = testBrowserRoot();
afterAll(() => { removeDir(temp); removeDir(browsers); });

it("counts runs within the requested task and stage, including repeated runs after reopening the log", () => {
  const db = new Database(":memory:");
  try {
    const log = new WorkLog(db);
    for (const [id, taskId, stageId, kind] of [
      ["first", "task-a", "build", "stage-start"], ["second", "task-a", "build", "stage-start"],
      ["other-stage", "task-a", "test", "stage-start"], ["other-task", "task-b", "build", "stage-start"],
      ["end", "task-a", "build", "stage-end"],
    ] as const) log.addMoment({ id, taskId, productId: "p", stageId, kind, at: 1 });
    expect(log.stageRuns("task-a", "build")).toBe(2);
    expect(log.stageRuns("task-a", "test")).toBe(1);
    expect(log.stageRuns("task-b", "build")).toBe(1);
    expect(log.stageRuns("missing", "build")).toBe(0);
    log.close();
    expect(new WorkLog(db).stageRuns("task-a", "build")).toBe(2);
  } finally { db.close(); }
});

it("attributes design answers to the last finished author in that stage and round", () => {
  const db = new Database(":memory:");
  try {
    const tracking = new Tracking({ store: { database: db } } as Kernel);
    const base: WorkTurn = { id: "original", taskId: "task-a", productId: "p", stageId: "design", stageTitle: "Design", stageKind: "converge", round: 2, fixing: false, roleId: "architect", toolId: "codex", profileId: "sol-high", sessionId: "session", reason: "first", startedAt: 1, mainOnly: false, helpers: 0 };
    for (const [index, extra] of [
      {}, { id: "replacement", profileId: "opus-high" }, { id: "later-round", round: 3 },
      { id: "other-stage", stageId: "other" }, { id: "other-role", roleId: "design-reviewer" },
      { id: "interrupted", profileId: "grok-high" }, { id: "other-task", taskId: "task-b" },
    ].entries()) {
      const turn = { ...base, ...extra, startedAt: index + 1 };
      tracking.log.startTurn(turn);
      if (turn.id !== "interrupted") tracking.log.endTurn(turn.id, { end: "finished", endedAt: index + 2, mainOnly: false, helpers: 0 }, []);
    }
    expect(tracking["author"]({ id: "task-a" } as MTask, { id: "design", roleId: "architect" } as MStage, 2)).toEqual({ roleId: "architect", profileId: "opus-high" });
  } finally { db.close(); }
});

async function makeRepo(parent: string, file = "README.md"): Promise<string> {
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, file), "# Demo\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** Wait for a condition on the engine's state, answering the inbox like a coordinator would. */
async function until(engine: Engine, done: (state: State) => boolean, respond: (engine: Engine, state: State) => void, ms = 60_000): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = engine.getState();
    if (done(state)) return state;
    if (Date.now() - started > ms * SLOW) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))} Inbox: ${JSON.stringify(state.inbox.map((item) => item.kind))}`);
    respond(engine, state);
    await Bun.sleep(50);
  }
}

/** Read the work log straight from the database, the way the engine keeps it. */
function readLog<T>(read: (log: WorkLog) => T): T {
  const db = new Database(join(data, "petrina.db"));
  try {
    return read(new WorkLog(db));
  } finally {
    db.close();
  }
}

describe("The work log of a real engine", () => {
  let repo = "";
  beforeAll(async () => { repo = await makeRepo(temp); });
  let engine = new Engine(data, options);
  let taskId = "";
  let productId = "";
  const permissionWait = 600;

  // A replaced engine is still stopping its agents while the test reads its successor. Drain those
  // stops when the test ends, however it ends: a file ending mid-stop leaves paused agents behind.
  const replaced: Promise<void>[] = [];
  afterEach(() => Promise.all(replaced.splice(0)));
  afterAll(() => engine.shutdown());

  it("takes a task from the queue to a commit on main, asking the coordinator along the way", async () => {
    productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    taskId = engine.addTask({ productId, title: "Add a greeting", description: "A friendly greeting file.", kind: "feature" });

    const seen = new Map<string, number>();
    const state = await until(
      engine,
      (current) => ["done", "failed"].includes(current.tasks.find((task) => task.id === taskId)?.state ?? ""),
      (current, snapshot) => {
        for (const item of snapshot.inbox) {
          if (!seen.has(item.id)) seen.set(item.id, Date.now());
          // The coordinator takes a moment over the permission: that wait is not agent work.
          if (item.kind === "permission" && Date.now() - seen.get(item.id)! < permissionWait) continue;
          if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") current.allow(item.id, "once");
          else current.approve(item.id);
        }
      },
    );

    const task = state.tasks.find((entry) => entry.id === taskId)!;
    expect(task.error).toBeUndefined();
    expect(task.state).toBe("done");
    expect(task.landed?.branch).toBe("main");
    // The coordinator was asked a question, a permission and two checkpoints.
    expect(task.timeline.some((entry) => entry.text.startsWith("You answered: Formal"))).toBe(true);
    expect(task.timeline.some((entry) => entry.text.includes("You allowed: Installing packages"))).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the design")).toBe(true);
    expect(task.timeline.some((entry) => entry.text === "You approved the delivery")).toBe(true);
    // The work is on main, with the permission granted.
    expect(await git(repo, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
    expect(task.findings.some((finding) => finding.severity === "suggestion")).toBe(true);
    await until(engine, (state) => !!state.tasks.find((entry) => entry.id === taskId)?.cleanup?.removedAt, () => undefined);
    expect(existsSync(task.worktree!)).toBe(false);
  });

  it("writes one work-log entry per agent turn, with what was asked and what ran", () => {
    const turns = readLog((log) => log.turns({ taskId }));
    const of = (roleId: string) => turns.filter((turn) => turn.roleId === roleId);
    expect(turns.every((turn) => turn.end === "finished" && turn.productId === productId && turn.workMs !== undefined && turn.endedAt! >= turn.startedAt)).toBe(true);
    expect(of("planner")[0]).toMatchObject({ stageKind: "plan", stageTitle: "Planning", toolId: "claude-code", profileId: "opus-high", modelAsked: "opus", modelRan: "opus", modelRanName: "Opus 5.5", effortAsked: "high", effortRan: "high", reason: "first", round: 1 });
    // The architect asked a question, so its stage took two turns: the first instructions, then the answer.
    expect(of("architect").map((turn) => turn.reason)).toEqual(["first", "answer"]);
    expect(new Set(of("architect").map((turn) => turn.sessionId)).size).toBe(1);
    expect(turns.every(turn => turn.journeyId && turn.agentRunId && turn.agentSeat)).toBe(true);
    expect(new Set(of("architect").map(turn => turn.agentRunId)).size).toBe(1);
    const task = engine.taskDetails(taskId)!;
    for (const step of task.journey ?? []) {
      if (step.kind !== "agent") continue;
      const own = turns.filter(turn => turn.journeyId === step.id);
      if (!own.length) continue;
      const view = engine.usage({ view: "node", taskId, nodeId: step.id });
      expect(view.tokens.value).toBe(own.some(turn => turn.tokens?.total !== undefined) ? own.reduce((sum, turn) => sum + (turn.tokens?.total ?? 0), 0) : undefined);
      expect(view.runs.reduce((sum, run) => sum + (run.tokens.value ?? 0), 0)).toBe(view.tokens.value ?? 0);
    }
    // The builder asked for sol at xhigh; this Codex doesn't offer them, so it kept its own default.
    expect(of("builder")[0]).toMatchObject({ toolId: "codex", modelAsked: "gpt-6.1-sol", effortAsked: "xhigh", modelRan: "gpt-6.1", effortRan: "medium", fixing: false });
  });

  it("keeps Claude Code's per-model breakdown as reported, counted once, with no helper figure", () => {
    const { turns, lines } = readLog((log) => ({ turns: log.turns({ taskId }), lines: log.lines({ taskId }) }));
    const architect = turns.filter((turn) => turn.roleId === "architect")[1]!;
    const own = lines.filter((line) => line.turnId === architect.id);
    expect(own.map((line) => [line.model, line.total]).sort()).toEqual([
      ["claude-haiku-5-5", 300],
      ["claude-opus-5-5", 1750],
    ]);
    // The main figure (1170) is never added on top of the breakdown.
    expect(architect.tokens).toMatchObject({ input: 190, cacheRead: 1740, cacheWrite: 30, output: 90, total: 2050 });
    expect(architect.mainOnly).toBe(false);
    for (const line of own) expect(Object.keys(line).sort()).toEqual(["cacheRead", "cacheWrite", "input", "model", "output", "total", "turnId"]);
  });

  it("records a turn with no usage, Codex helpers and reroutes, a fallback, and leaves the permission wait out", () => {
    const { turns, lines } = readLog((log) => ({ turns: log.turns({ taskId }), lines: log.lines({ taskId }) }));
    const reviewer = turns.find((turn) => turn.roleId === "design-reviewer")!;
    expect(reviewer.tokens).toBeUndefined();
    expect(reviewer.workMs).toBeGreaterThanOrEqual(0);
    const builder = turns.find((turn) => turn.roleId === "builder")!;
    expect(builder).toMatchObject({ helpers: 1, mainOnly: true, tokens: { input: 100, cacheRead: 1000, cacheWrite: 0, output: 50, reasoning: 20, total: 1150 } });
    expect(builder.workMs!).toBeLessThan(builder.endedAt! - builder.startedAt - permissionWait + 150);
    // The two reviewers look at the change at once, so either may finish first.
    const review = (profileId: string) => turns.find((turn) => turn.roleId === "code-reviewer" && turn.profileId === profileId) as WorkTurn;
    const [opusReview, codexReview] = [review("opus-high"), review("sol-high")];
    expect(opusReview).toMatchObject({ profileId: "opus-high", modelRan: "opus", modelChangedTo: "Sonnet 5.5" });
    expect(codexReview).toMatchObject({ profileId: "sol-high", modelChangedTo: "gpt-6.1-mini" });
    expect(lines.find((line) => line.turnId === codexReview.id)).toMatchObject({ model: "gpt-6.1", changed: true });
  });

  it("logs the moments: stages, design rounds, verdicts, questions and the delivery", () => {
    const moments = readLog((log) => log.moments({ taskId }));
    const kinds = (kind: string) => moments.filter((moment) => moment.kind === kind);
    expect(kinds("stage-start").length).toBe(kinds("stage-end").length);
    expect(kinds("stage-end").map((moment) => moment.outcome)).toEqual(["done", "settled", "done", "passed", "delivered"]);
    expect(kinds("stage-end").every((moment) => (moment.durationMs ?? -1) >= (moment.workMs ?? 0))).toBe(true);
    expect(kinds("design-round")[0]).toMatchObject({ roleId: "architect", profileId: "opus-xhigh", peerRoleId: "design-reviewer", peerProfileId: "sol-xhigh", count: 0, blocking: 0 });
    expect(kinds("design-end")[0]).toMatchObject({ outcome: "settled", rounds: 1 });
    expect(kinds("verdict").map((moment) => moment.profileId).sort()).toEqual(["opus-high", "sol-high"]);
    expect(kinds("ask").map((moment) => [moment.ask, moment.answer])).toEqual([
      ["question", "answered"],
      ["checkpoint", "approved"],
      ["permission", "allowed"],
      ["checkpoint", "approved"],
    ]);
    expect(kinds("ask")[2]!.durationMs!).toBeGreaterThanOrEqual(permissionWait - 50);
    expect(kinds("task-end").map((moment) => moment.outcome)).toEqual(["delivered"]);
  });

  it("keeps only numbers, names and ids, never the dollar figure, and shares limits through the state", async () => {
    const dump = readLog((log) => JSON.stringify([log.turns({}), log.lines({}), log.moments({})]));
    expect(dump).not.toContain("USD");
    expect(dump).not.toContain("1.2345");
    expect(dump).not.toContain("greeting.txt");
    expect(dump).not.toContain("left-pad");
    expect(dump).not.toContain("Formal");
    // Codex limits come from the installed Codex (here a stand-in), read after a Codex turn.
    await until(engine, (state) => (state.pool.usage ?? []).some((limit) => limit.toolId === "codex"), () => undefined, 10_000);
    const limits = engine.getState().pool.usage!;
    expect(limits.find((limit) => limit.toolId === "claude-code")).toMatchObject({ kind: "five_hour", utilization: 0.81, status: "allowed" });
    expect(limits.find((limit) => limit.toolId === "codex")).toMatchObject({ windowMinutes: 10_080, utilization: 0.16 });
    expect(JSON.stringify(limits)).not.toContain("not-for-petrina");
    // Every reading also went into the thirty-day history, once per change, so Analytics can draw each limit over time.
    const history = readLog((log) => log.usageHistory({}));
    expect(history.filter((entry) => entry.toolId === "claude-code" && entry.kind === "five_hour")).toHaveLength(1);
    expect(history.some((entry) => entry.toolId === "codex" && entry.utilization === 0.16)).toBe(true);
    const limitsToday = engine.usage({ view: "analytics", period: "today" }).limits;
    expect(limitsToday.tools.map((tool) => tool.toolId).sort()).toEqual(["claude-code", "codex"]);
    expect(limitsToday.tools.find((tool) => tool.toolId === "claude-code")!.limits[0]!.latest.utilization).toBe(0.81);
  });

  it("answers only the defined views and periods", async () => {
    const view = (await dispatch(engine, { name: "usage", args: [{ view: "task", taskId }] })) as { stages: { title: string; agents: { roleId: string; settings: string }[] }[] };
    // Petrina commits to main by itself: no agent works on that stage, so it used nothing and isn't listed.
    expect(view.stages.map((stage) => stage.title)).toEqual(["Planning", "Design", "Build", "Review"]);
    expect(view.stages[2]!.agents[0]!.settings).toBe("asked for sol at xhigh, ran gpt-6.1 at medium");
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "everything" }] }));
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "analytics", period: "year" }] }));
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "today", sql: "DROP TABLE work_turns" }] }));
    const analytics = (await dispatch(engine, { name: "usage", args: [{ view: "analytics", period: "7d" }] })) as { headline: { turns: number } };
    expect(analytics.headline.turns).toBeGreaterThan(5);
  });

  it("keeps the log across a restart, and marks a turn cut off by a stop as lost", async () => {
    const before = engine.usage({ view: "task", taskId });
    replaced.push(engine.shutdown());
    engine = new Engine(data, options);
    expect(engine.usage({ view: "task", taskId })).toEqual(before);

    const hanging = engine.addTask({ productId, title: "HANG-FOREVER please", kind: "chore" });
    await until(engine, () => readLog((log) => log.turns({ taskId: hanging }).some((turn) => turn.end === undefined)), () => undefined, 20_000);
    // Nothing starts again after the restart, so the lost turn is the only one.
    engine.setPoolPaused(true);
    replaced.push(engine.shutdown());
    engine = new Engine(data, options);
    const lost = readLog((log) => log.turns({ taskId: hanging }));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ end: "lost" });
    expect(lost[0]!.workMs).toBeUndefined();
    const view = engine.usage({ view: "task", taskId: hanging });
    expect(view.time.atLeast && view.tokens.atLeast).toBe(true);
    expect(view.atLeast).toContain("cut off when Petrina stopped");
    engine.cancel(hanging);
  });

  it("keeps a switch the tool confirmed during a turn, even when the agent stops before replying", async () => {
    engine.setPoolPaused(false);
    const stopping = engine.addTask({ productId, title: "SWITCH-THEN-STOP please", kind: "chore" });
    await until(engine, () => readLog((log) => log.turns({ taskId: stopping }).some((turn) => turn.end !== undefined)), () => undefined, 20_000);
    engine.setPoolPaused(true);
    const [stopped] = readLog((log) => log.turns({ taskId: stopping }));
    expect(stopped).toMatchObject({ end: "agent-stopped", modelRan: "opus", effortRan: "high", modelChangedTo: "Sonnet 5.5", effortChangedTo: "low" });
    expect(stopped!.tokens).toBeUndefined();
    engine.cancel(stopping);
  });

  it("never gives a removed product's id or history to another repository, even after the state is lost", async () => {
    engine.removeProduct(productId);
    // A different repository with the same name.
    const other = await makeRepo(join(temp, "elsewhere"), "OTHER.md");
    const fresh = await engine.addProduct(other);
    expect(fresh).not.toBe(productId);
    expect(engine.getState().tasks.filter((task) => task.productId === fresh)).toHaveLength(0);
    expect(engine.usage({ view: "products" }).products.find((entry) => entry.productId === fresh)).toMatchObject({ turns: 0, tokens: { value: 0 } });
    const split = engine.usage({ view: "analytics", period: "7d" }).byProduct!;
    expect(split.find((line) => line.productId === productId)).toMatchObject({ label: "Repo", note: "removed" });
    // Adding the same repository again starts a new product too; the old history stays with the removed one.
    engine.removeProduct(fresh);
    const again = await engine.addProduct(repo);
    expect([productId, fresh]).not.toContain(again);

    // Lose the saved state entirely: ids in the work log are still never handed out again.
    const loggedTasks = readLog((log) => [...new Set(log.turns({}).map((turn) => turn.taskId))]);
    await engine.shutdown();
    const db = new Database(join(data, "petrina.db"));
    db.run("UPDATE kv SET value = '{not json' WHERE key = 'state'");
    db.close();
    engine = new Engine(data, options);
    expect(engine.getState().products).toHaveLength(0);
    const reborn = await engine.addProduct(repo);
    expect([productId, fresh, again]).not.toContain(reborn);
    engine.setPoolPaused(true);
    const newTask = engine.addTask({ productId: reborn, title: "After the loss", kind: "chore" });
    expect(loggedTasks).not.toContain(newTask);
    expect(readFileSync(join(data, "petrina.db")).length).toBeGreaterThan(0);
  });

  it("on the first start with a work log, protects ids of products that are gone and marks earlier work", async () => {
    const dir = join(temp, "upgrade");
    const store = new Store(join(dir, "petrina.db"));
    const started = (id: string, productId: string): Task => ({
      id, productId, title: id, description: "", area: id, kind: "chore", priority: 0, held: false, state: "done", column: "done", holdsSlot: false, approvePlan: false,
      delivery: "local", approveDelivery: false, stageIndex: 2, rounds: {}, sub: 0, fixing: false, statusLine: "", createdAt: 1, startedAt: 2, finishedAt: 3,
      timeline: [], session: [], queued: [], objections: [], findings: [],
    });
    store.save({
      now: 1, seq: 7, products: [{ id: "alive", name: "Alive", repo: "acme/alive", tone: "blue" }], roles: [], tools: [], profiles: [],
      tasks: [started("task-3", "alive"), started("task-5", "repo")], inbox: [], pool: { limit: 2, paused: true, toolCaps: {} },
    });
    store.close();
    const upgraded = new Engine(dir, { ...options, usageCommands: { codex: null } });
    try {
      // "repo" was removed before Petrina kept names: its id is protected, and it reads as a removed product.
      const db = new Database(join(dir, "petrina.db"));
      const log = new WorkLog(db);
      expect(log.products().find((record) => record.id === "repo")).toMatchObject({ id: "repo" });
      expect(log.products().find((record) => record.id === "repo")?.removedAt).toBeGreaterThan(0);
      expect([...log.untracked().keys()].sort()).toEqual(["task-3", "task-5"]);
      db.close();
      expect(await upgraded.addProduct(repo)).toBe("repo-2");
      expect(upgraded.usage({ view: "task", taskId: "task-3" }).empty).toBe("untracked");
      expect(upgraded.usage({ view: "products" }).products.find((entry) => entry.productId === "alive")?.tokens.atLeast).toBe(true);
    } finally {
      await upgraded.shutdown();
    }
  });
});

describe("A step a usage limit stopped", () => {
  it("keeps the retry it owes across a restart, and drops a saved list it cannot read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "petrina-owed-")), "petrina.db");
    try {
      const first = new Database(file);
      new WorkLog(first).setOwedRetries(["task-3|builder|opus-high"]);
      first.close();
      const again = new Database(file);
      const log = new WorkLog(again);
      expect(log.owedRetries()).toEqual(["task-3|builder|opus-high"]);
      again.query("UPDATE work_meta SET value = 'not a list' WHERE key = 'owed-retries'").run();
      expect(log.owedRetries()).toEqual(["task-3|builder|opus-high"]);
      expect(new WorkLog(again).owedRetries()).toEqual([]);
      log.close();
      // Petrina is stopping: nothing more is written.
      log.setOwedRetries(["task-4|builder|opus-high"]);
      expect(log.owedRetries()).toEqual([]);
      again.close();
    } finally {
      removeDir(join(file, ".."));
    }
  });
});

describe("An agent session", () => {
  it("keeps unfamiliar model names exactly as reported, including long names with different endings", () => {
    const prefix = `unfamiliar-${"model-".repeat(40)}`;
    const names = [`${prefix}[fast]`, `${prefix}[careful]`];
    const report = reportOf({ _meta: { quota: { model_usage: names.map((model) => ({ model, token_count: { inputTokens: 10, outputTokens: 5 } })) } } });
    expect(report?.models?.map((row) => row.model)).toEqual(names);
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      log.startTurn({ id: "long-names", taskId: "names", productId: "product", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "claude-code", profileId: "opus-high", sessionId: "session", reason: "first", startedAt: 1, mainOnly: false, helpers: 0 });
      log.endTurn("long-names", { end: "finished", endedAt: 2, workMs: 1, mainOnly: false, helpers: 0, tokens: { total: 30 } }, names.map((model) => ({ model, total: 15 })));
      expect(log.lines({ taskId: "names" }).map((line) => line.model).sort()).toEqual([...names].sort());
    } finally {
      db.close();
    }
  });

  it("reads 'not confirmed' when the tool acknowledges a setting without saying what it ended up on", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "petrina-run-"));
    const profile = ENGINE_PROFILES.find((entry) => entry.id === "opus-high")!;
    const callbacks = { onActivity: () => undefined, onPlanStep: () => undefined, onPermission: async () => "deny" as const };
    const start = (env: NodeJS.ProcessEnv) => AgentRun.start({ profile, cwd, callbacks, signal: new AbortController().signal, command: [process.execPath, fake, "--tool=claude-code"], env, browserTempRoot: browsers });
    let bare: AgentRun | undefined, echoed: AgentRun | undefined;
    try {
      bare = await start({ ...process.env, FAKE_BARE_ACK: "1" });
      echoed = await start(process.env);
      // Petrina asked for opus at high and the tool only said "ok": neither is taken as confirmed.
      expect(bare.settings).toEqual({});
      expect(echoed.settings).toEqual({ model: "opus", modelName: "Opus 5.5", effort: "high" });
    } finally {
      // Wait for both stops: a stop pauses its agent while it lists the agent's programs.
      await Promise.all([bare?.stop(), echoed?.stop()]);
      removeDir(cwd);
    }
  });

  it("counts overlapping waits for the coordinator once", () => {
    const clock = new WaitClock();
    clock.start("task", 0);
    clock.start("task", 100);
    expect(clock.of("task", 200)).toBe(200);
    clock.stop("task", 300);
    clock.stop("task", 500);
    // Two permission questions open at once, from 0 to 500: 500ms of waiting, not 700.
    expect(clock.of("task", 900)).toBe(500);
    clock.start("task", 1000);
    clock.stop("task", 1100);
    expect(clock.of("task", 2000)).toBe(600);
    expect(clock.of("other", 2000)).toBe(0);
  });
});
