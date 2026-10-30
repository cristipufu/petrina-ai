import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { expectRejection } from "@petrina/test-support/rejections";
// The work log, end to end: a real engine with the fake agent reporting usage and settings the
// way Claude Code and Codex do, and the product list that never hands an id out again.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import type { State, Task, WorkTurn } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";



import { Engine } from "../../engine.js";
import { dispatch } from "../../../src/server.js";
import { Store } from "@petrina/storage/store";

import { WorkLog } from "@petrina/storage/worklog";
import type { CodexScript } from "../../../../agent-runtime/test/fixtures/fake-codex.js";
import { createProductRepository, SLOW, testBrowserRoot, waitFor } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";

const fake = join(import.meta.dir, "../..", "fake-agent.ts");
const fakeCodex = join(import.meta.dir, "../..", "../../agent-runtime/test/fixtures/fake-codex.ts");
async function makeRepo(parent: string, file = "README.md"): Promise<string> {
  const { path: clone } = await createProductRepository(join(parent, "repo-seed"), { origin: "none" });
  const repo = join(parent, "repo");
  renameSync(clone, repo);
  if (file !== "README.md") {
    rmSync(join(repo, "README.md"), { force: true });
    writeFileSync(join(repo, file), "# Demo\n");
    await gitOps.commitChanges(repo, "init");
  }
  return repo;
}

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


const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

describe("The work log of a real engine", () => {
  it("takes a task from the queue to a commit on main, asking the coordinator along the way", async () => {
    return engineCases.use("petrina-worklog-", async caseOwner => {
const temp = caseOwner.root;
const data = join(temp, "data");
// The stand-in Codex app-server's answer, and its log of every request it gets.
const codexDir = join(temp, "codex");
mkdirSync(codexDir);
writeFileSync(join(codexDir, "codex.json"), JSON.stringify({ primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: Math.round(Date.now() / 1000) + 5 * 86_400 } } satisfies CodexScript));
// Each profile's agent behaves like its own tool: Claude Code or Codex. The stand-ins count as the tools'
// installed apps whatever this machine has, so every engine here, restarts included, reads Codex's usage
// from the stand-in app-server and never from a real Codex or account.
const options = { agentCommand: (profile: { toolId: string }) => [process.execPath, fake, `--tool=${profile.toolId}`], toolPath: () => fake, toolProbe: privateAgentToolProbe(), usageCommands: { codex: [process.execPath, fakeCodex, codexDir] } };

// Conversations started here keep their browsers, in this file's own browser folder.
const browsers = testBrowserRoot();
registerFixtureRoot(browsers);
caseOwner.afterBody(async () => { await caseOwner.stopAll(); removeFixtureRoot(browsers); });
async function codexUsageRead(engine: Engine): Promise<void> {
  expect(engine.getState().tools.find((tool) => tool.id === "codex")?.status, "the stand-in Codex counts as installed").toBe("ready");
  const reader = engine.usageCoordinator.readers.get("codex");
  expect(reader, "the engine started its Codex usage reader").toBeDefined();
  expect(reader!.snapshot(), "the engine asked its Codex usage reader").toBeDefined();
  const read = await waitFor(() => {
    const current = reader!.snapshot();
    return current?.state !== "reading" && current;
  }, "the Codex usage read to finish");
  const asked = existsSync(join(codexDir, "codex.jsonl")) ? readFileSync(join(codexDir, "codex.jsonl"), "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { method: string }).method) : [];
  expect(asked, "the stand-in Codex app-server received the usage request").toContain("account/rateLimits/read");
  expect(read.state, "the stand-in Codex app-server's answer was read").toBe("reported");
}

function readLog<T>(read: (log: WorkLog) => T): T {
  const db = new Database(join(data, "petrina.db"));
  try {
    return read(new WorkLog(db));
  } finally {
    db.close();
  }
}

    const repo = await makeRepo(temp);
    const openEngine = () => installSharedWorkflowFastPaths(caseOwner.open(data, options));
    let engine = openEngine();
    let taskId = "", productId = "";
    const permissionWait = 600;
    const replaced: Promise<void>[] = [];
    const settleReplaced = async () => {
      const settled = await Promise.allSettled(replaced.splice(0));
      const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Replaced work-log Engines did not all stop");
    };
    // takes a task from the queue to a commit on main, asking the coordinator along the way
    const scenario1 = async () => {
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
    expect(readFileSync(join(repo, "greeting.txt"), "utf8").trim()).toBe("Hello (with left-pad)");
    expect(task.findings.some((finding) => finding.severity === "suggestion")).toBe(true);
    await until(engine, (state) => !!state.tasks.find((entry) => entry.id === taskId)?.cleanup?.removedAt, () => undefined);
    expect(existsSync(task.worktree!)).toBe(false);
  };

    // writes one work-log entry per agent turn, with what was asked and what ran
    const scenario2 = async () => {
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
  };

    // keeps Claude Code's per-model breakdown as reported, counted once, with no helper figure
    const scenario3 = async () => {
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
  };

    // records a turn with no usage, Codex helpers and reroutes, a fallback, and leaves the permission wait out
    const scenario4 = async () => {
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
  };

    // logs the moments: stages, design rounds, verdicts, questions and the delivery
    const scenario5 = async () => {
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
  };

    // keeps only numbers, names and ids, never the dollar figure, and shares limits through the state
    const scenario6 = async () => {
    const dump = readLog((log) => JSON.stringify([log.turns({}), log.lines({}), log.moments({})]));
    expect(dump).not.toContain("USD");
    expect(dump).not.toContain("1.2345");
    expect(dump).not.toContain("greeting.txt");
    expect(dump).not.toContain("left-pad");
    expect(dump).not.toContain("Formal");
    // Codex limits come from the installed Codex (here a stand-in), read after a Codex turn.
    await codexUsageRead(engine);
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
  };

    // answers only the defined views and periods
    const scenario7 = async () => {
    const view = (await dispatch(engine, { name: "usage", args: [{ view: "task", taskId }] })) as { stages: { title: string; agents: { roleId: string; settings: string }[] }[] };
    // Petrina commits to main by itself: no agent works on that stage, so it used nothing and isn't listed.
    expect(view.stages.map((stage) => stage.title)).toEqual(["Planning", "Design", "Build", "Review"]);
    expect(view.stages[2]!.agents[0]!.settings).toBe("asked for sol at xhigh, ran gpt-6.1 at medium");
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "everything" }] }));
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "analytics", period: "year" }] }));
    await expectRejection(dispatch(engine, { name: "usage", args: [{ view: "today", sql: "DROP TABLE work_turns" }] }));
    const analytics = (await dispatch(engine, { name: "usage", args: [{ view: "analytics", period: "7d" }] })) as { headline: { turns: number } };
    expect(analytics.headline.turns).toBeGreaterThan(5);
  };

    // keeps the log across a restart, and marks a turn cut off by a stop as lost
    const scenario8 = async () => {
    const before = engine.usage({ view: "task", taskId });
    const firstStop = caseOwner.stop(engine);
    replaced.push(firstStop);
    engine = openEngine();
    expect(engine.usage({ view: "task", taskId })).toEqual(before);

    const hanging = engine.addTask({ productId, title: "HANG-FOREVER please", kind: "chore" });
    await until(engine, () => readLog((log) => log.turns({ taskId: hanging }).some((turn) => turn.end === undefined)), () => undefined, 20_000);
    // Nothing starts again after the restart, so the lost turn is the only one.
    engine.setPoolPaused(true);
    const interruptedStop = caseOwner.stop(engine);
    replaced.push(interruptedStop);
    engine = openEngine();
    const lost = readLog((log) => log.turns({ taskId: hanging }));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ end: "lost" });
    expect(lost[0]!.workMs).toBeUndefined();
    const view = engine.usage({ view: "task", taskId: hanging });
    expect(view.time.atLeast && view.tokens.atLeast).toBe(true);
    expect(view.atLeast).toContain("cut off when Petrina stopped");
    engine.cancel(hanging);
    await Promise.all([firstStop, interruptedStop]);
  };

    // keeps a switch the tool confirmed during a turn, even when the agent stops before replying
    const scenario9 = async () => {
    engine.setPoolPaused(false);
    const stopping = engine.addTask({ productId, title: "SWITCH-THEN-STOP please", kind: "chore" });
    await until(engine, () => readLog((log) => log.turns({ taskId: stopping }).some((turn) => turn.end !== undefined)), () => undefined, 20_000);
    engine.setPoolPaused(true);
    const [stopped] = readLog((log) => log.turns({ taskId: stopping }));
    expect(stopped).toMatchObject({ end: "agent-stopped", modelRan: "opus", effortRan: "high", modelChangedTo: "Sonnet 5.5", effortChangedTo: "low" });
    expect(stopped!.tokens).toBeUndefined();
    engine.cancel(stopping);
  };

    // never gives a removed product's id or history to another repository, even after the state is lost
    const scenario10 = async () => {
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
    await caseOwner.stop(engine);
    const db = new Database(join(data, "petrina.db"));
    const closeDatabase = caseOwner.afterBody(() => db.close());
    db.run("UPDATE kv SET value = '{not json' WHERE key = 'state'");
    await closeDatabase();
    engine = openEngine();
    expect(engine.getState().products).toHaveLength(0);
    const reborn = await engine.addProduct(repo);
    expect([productId, fresh, again]).not.toContain(reborn);
    engine.setPoolPaused(true);
    const newTask = engine.addTask({ productId: reborn, title: "After the loss", kind: "chore" });
    expect(loggedTasks).not.toContain(newTask);
    expect(readFileSync(join(data, "petrina.db")).length).toBeGreaterThan(0);
  };
    try {
      await caseOwner.prepare(scenario1); await settleReplaced();
      await caseOwner.prepare(scenario2); await settleReplaced();
      await caseOwner.prepare(scenario3); await settleReplaced();
      await caseOwner.prepare(scenario4); await settleReplaced();
      await caseOwner.prepare(scenario5); await settleReplaced();
      await caseOwner.prepare(scenario6); await settleReplaced();
      await caseOwner.prepare(scenario7); await settleReplaced();
      await caseOwner.prepare(scenario8); await settleReplaced();
      await caseOwner.prepare(scenario9); await settleReplaced();
      await caseOwner.prepare(scenario10); await settleReplaced();
    } finally { await settleReplaced(); }
    }, { allowOverlap: true });
  });

  it("on the first start with a work log, protects ids of products that are gone and marks earlier work", async () => engineCases.use("petrina-worklog-upgrade-", async caseOwner => {

    const temp = caseOwner.root, dir = join(temp, "upgrade");
    const repo = await makeRepo(temp);
    const options = { agentCommand: (profile: { toolId: string }) => [process.execPath, fake, `--tool=${profile.toolId}`], toolPath: () => fake, toolProbe: privateAgentToolProbe() };
    const store = new Store(join(dir, "petrina.db"));
    const closeStore = caseOwner.afterBody(() => store.close());
    const started = (id: string, productId: string): Task => ({
      id, productId, title: id, description: "", area: id, kind: "chore", priority: 0, held: false, state: "done", column: "done", holdsSlot: false, approvePlan: false,
      delivery: "local", approveDelivery: false, stageIndex: 2, rounds: {}, sub: 0, fixing: false, statusLine: "", createdAt: 1, startedAt: 2, finishedAt: 3,
      timeline: [], session: [], queued: [], objections: [], findings: [],
    });
    store.save({
      now: 1, seq: 7, products: [{ id: "alive", name: "Alive", repo: "acme/alive", tone: "blue" }], roles: [], tools: [], profiles: [],
      tasks: [started("task-3", "alive"), started("task-5", "repo")], inbox: [], pool: { limit: 2, paused: true, toolCaps: {} },
    });
    await closeStore();
    const upgraded = caseOwner.open(dir, { ...options, usageCommands: { codex: null } });
    try {
      // "repo" was removed before Petrina kept names: its id is protected, and it reads as a removed product.
      const db = new Database(join(dir, "petrina.db"));
      const closeDatabase = caseOwner.afterBody(() => db.close());
      const log = new WorkLog(db);
      expect(log.products().find((record) => record.id === "repo")).toMatchObject({ id: "repo" });
      expect(log.products().find((record) => record.id === "repo")?.removedAt).toBeGreaterThan(0);
      expect([...log.untracked().keys()].sort()).toEqual(["task-3", "task-5"]);
      await closeDatabase();
      expect(await upgraded.addProduct(repo)).toBe("repo-2");
      expect(upgraded.usage({ view: "task", taskId: "task-3" }).empty).toBe("untracked");
      expect(upgraded.usage({ view: "products" }).products.find((entry) => entry.productId === "alive")?.tokens.atLeast).toBe(true);
    } finally {
      await caseOwner.stop(upgraded);
    }

  }));
});
