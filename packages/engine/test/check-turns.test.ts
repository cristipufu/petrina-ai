import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, slotUses, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { Aborted } from "../src/kernel.js";
import { WaitingForUsage } from "../src/usage.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("tasks' checks take turns on one machine", () => {
  for (const checkRuns of [1, 2]) it(`hands a released place to the waiting task before a new arrival (limit ${checkRuns})`, async () => {
    const root = tempDir("petrina-check-handoff-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { usageCommands: { codex: null }, checkRuns });
    engine.setPoolPaused(true);
    const held: (() => void)[] = [];
    try {
      const productId = await engine.addProduct(await makeProduct(root));
      const task = engine.task(engine.addTask({ productId, title: "A check waiting its turn" }))!;
      engine.setHeld(task.id, true);
      engine.setPoolPaused(false);
      const acquire = () => engine["checks"]["turnToRun"](executionFor(task), new AbortController().signal);
      for (let i = 0; i < checkRuns; i++) held.push(await acquire());
      const started: string[] = [];
      const queued = acquire().then((release) => { started.push("waiting task"); held.push(release); return release; });
      held[0]!();
      // Arrive in the same turn, before the waiting task's promise resumes.
      const newcomer = acquire().then((release) => { started.push("new arrival"); held.push(release); return release; });
      const releaseWaiting = await queued;
      expect(started).toEqual(["waiting task"]);
      // A repeated completion must not hand out a second place.
      held[0]!();
      await Promise.resolve();
      expect(started).toEqual(["waiting task"]);
      releaseWaiting();
      await newcomer;
      expect(started).toEqual(["waiting task", "new arrival"]);
    } finally {
      for (const release of held) release();
      await engine.shutdown();
    }
  });

  it("skips a cancelled waiter and rejects an already cancelled run without taking a place", async () => {
    const root = tempDir("petrina-check-cancel-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { usageCommands: { codex: null } });
    engine.setPoolPaused(true);
    const held: (() => void)[] = [];
    try {
      const productId = await engine.addProduct(await makeProduct(root));
      const task = engine.task(engine.addTask({ productId, title: "A cancelled check" }))!;
      engine.setHeld(task.id, true);
      engine.setPoolPaused(false);
      const acquire = (signal = new AbortController().signal) => engine["checks"]["turnToRun"](executionFor(task), signal);
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await acquire(cancelled.signal).then(() => "started", (error) => error)).toBeInstanceOf(Aborted);
      const releaseFirst = await acquire();
      held.push(releaseFirst);
      // Already aborted requests must also reject while the queue is occupied.
      expect(await acquire(cancelled.signal).then(() => "started", (error) => error)).toBeInstanceOf(Aborted);
      const controller = new AbortController();
      const waiting = acquire(controller.signal).then(() => "started", (error) => error);
      const next = acquire().then((release) => { held.push(release); return release; });
      controller.abort();
      expect(await waiting).toBeInstanceOf(Aborted);
      releaseFirst();
      const releaseNext = await next;
      releaseNext();
      const releaseBusy = await acquire();
      held.push(releaseBusy);
      const late = new AbortController();
      const handedOff = acquire(late.signal).then(() => "started", (error) => error);
      const follower = acquire().then((release) => { held.push(release); return release; });
      releaseBusy();
      // Abort after the place was reserved, before the waiting continuation runs.
      late.abort();
      expect(await handedOff).toBeInstanceOf(Aborted);
      const releaseFollower = await follower;
      releaseFollower();
      // Cancellation and repeated releases leave the queue usable.
      held.push(await acquire());
    } finally {
      for (const release of held) release();
      await engine.shutdown();
    }
  });

  for (const draining of [false, true]) it(`releases a reserved check place when ${draining ? "draining" : "paused"} during its handoff`, async () => {
    const root = tempDir("petrina-check-admission-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null },  });
    engine.setPoolPaused(true);
    const held: (() => void)[] = [];
    try {
      const productId = await engine.addProduct(await makeProduct(root));
      const task = engine.task(engine.addTask({ productId, title: "A check at the drain boundary" }))!;
      engine.setHeld(task.id, true);
      engine.setPoolPaused(false);
      const acquire = () => engine["checks"]["turnToRun"](executionFor(task), new AbortController().signal);
      const release = await acquire();
      held.push(release);
      const waiting = acquire().then(() => "started", (error) => error);
      const follower = acquire().then(() => "started", (error) => error);
      release();
      // The queue has reserved the released place, but the next check has not been admitted.
      if (draining) engine.draining = true;
      else engine.setPoolPaused(true);
      expect(await waiting).toBeInstanceOf(WaitingForUsage);
      expect(await follower).toBeInstanceOf(WaitingForUsage);
      release();
      engine.draining = false;
      engine.setPoolPaused(false);
      held.push(await acquire());
      expect(engine["checks"]["running"]).toBe(1);
      held.at(-1)!();
      expect(engine["checks"]["running"]).toBe(0);
    } finally {
      for (const release of held) release();
      await engine.shutdown();
    }
  });

  it("runs one task's checks while the other waits its turn, and both get through", async () => {
    const root = tempDir("petrina-check-turns-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ checks: "slow" });
    const hold = join(root, "hold-check");
    const runs = join(root, "check-runs");
    const check = join(root, "check.ts");
    const script = join(fakes.dir, "agents.json");
    writeFileSync(hold, "");
    // Hold the first check until another task really waits, however far apart their agents finish.
    // The shared lock also makes an overlapping run fail instead of silently passing the fixture.
    writeFileSync(check, `import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
const lock = ${JSON.stringify(join(root, "checking"))};
mkdirSync(lock);
try {
  appendFileSync(${JSON.stringify(runs)}, process.cwd() + "\\n");
  while (existsSync(${JSON.stringify(hold)})) await Bun.sleep(20);
} finally { rmSync(lock, { recursive: true }); }
`);
    writeFileSync(script, JSON.stringify({ checks: [{ name: "Held check", argv: [process.execPath, check], why: "Waits until the other task is in line" }] }));
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--script=${script}`] });
    // Admission reserves the slot before Git/environment preparation starts the actual command.
    // Exercise that gap deliberately instead of relying on how quickly this machine starts checks.
    let startFirst!: () => void;
    const firstStart = new Promise<void>((resolve) => { startFirst = resolve; });
    const runAll = engine["checks"]["runAll"].bind(engine["checks"]);
    let first = true;
    engine["checks"]["runAll"] = async (...args) => {
      if (first) { first = false; await firstStart; }
      return runAll(...args);
    };
    let waitedBeforeStart = false;
    let occupiedDuringChecks: number | undefined;
    let waitingStep: { taskId: string; stepId: string; startedAt: number; evidence: NonNullable<Task["journey"]>[number]; running: { name: string; startedAt?: number } } | undefined;
    const unsubscribe = engine.subscribe(() => {
      const state = engine.activeState();
      const task = state.tasks.find((task) => task.statusLine === "Waiting to run the checks: another task's run comes first");
      if (!task || waitingStep) return;
      // A place is reserved before the diagnostic log opens and start is reported.
      // Compare the running check with its queued peer only after that report.
      const running = state.tasks.flatMap((entry) => entry.journey?.at(-1)?.productChecks ?? []).find((check) => check.result === "running");
      if (!running) {
        waitedBeforeStart = true;
        startFirst();
        return;
      }
      const step = task.journey!.at(-1)!;
      // Snapshot the evidence and assert after the run. An assertion thrown by an update listener
      // would abort the check and replace its pending evidence with "stopped" during cleanup.
      occupiedDuringChecks = slotUses(state).length;
      waitingStep = { taskId: task.id, stepId: step.id, startedAt: step.startedAt, evidence: JSON.parse(JSON.stringify(step)) as typeof step, running: { ...running } };
    });
    try {
      const productId = await engine.addProduct(await makeProduct(root));
      const ids = [engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" }), engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" })];
      await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        // The progress event can precede process startup. Wait for the check's own marker as well
        // before releasing it, so the lock still proves the two commands never overlap.
        if (waitingStep && existsSync(runs)) rmSync(hold, { force: true });
        const tasks = ids.map((id) => state.tasks.find((entry) => entry.id === id) as Task | undefined);
        if (tasks.some((task) => task?.state === "failed")) throw new Error("a task failed");
        return ids.every((id) => state.inbox.some((item) => item.taskId === id && item.kind === "delivery"));
      }, "both delivery checks", 90_000);
      expect(waitedBeforeStart).toBe(true);
      expect(occupiedDuringChecks).toBe(0);
      expect(waitingStep).toBeDefined();
      expect(waitingStep!.evidence).toMatchObject({ kind: "petrina", work: "checks" });
      expect(waitingStep!.evidence.endedAt).toBeUndefined();
      expect(waitingStep!.evidence.productChecks).toEqual([expect.objectContaining({ name: "Held check", result: "pending" })]);
      expect(waitingStep!.running.name).toBe("Held check");
      expect(waitingStep!.running.startedAt).toBeNumber();
      const task = engine.getState().tasks.find((task) => task.id === waitingStep!.taskId)!;
      expect(task.journey!.find((step) => step.id === waitingStep!.stepId)).toMatchObject({ startedAt: waitingStep!.startedAt, end: "done", outcome: "The check passes" });
      for (const task of engine.getState().tasks) expect(journeyProblems(task)).toEqual([]);
      const checked = new Set(readFileSync(runs, "utf8").trim().split("\n").map((path) => realpathSync.native(path)));
      const copies = new Set(ids.map((id) => realpathSync.native(engine.getState().tasks.find((task) => task.id === id)!.worktree!)));
      expect(checked).toEqual(copies);
    } finally {
      unsubscribe();
      startFirst();
      rmSync(hold, { force: true });
      await engine.shutdown();
    }
  });
});

it("admits bounded check preparation while every model slot is occupied", async () => {
  const root = tempDir("petrina-check-separate-capacity-");
  roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null },  });
  engine.setPoolPaused(true);
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "Prepare checks without reserving a reviewer", backlog: true }))!;
    task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 }] };
    task.stageIndex = 0;
    task.rounds = { review: 1 };
    engine.s.pool.limit = 1;
    engine.s.backgroundAgents = [{ id: "occupied", roleId: "verifier", profileId: "sol-high", label: "Comparing older bugs", since: Date.now() }];
    engine.setPoolPaused(false);
    // Admission only: the driver has not started I/O or asked a reviewer anything yet.
    expect(engine["driver"]["reserveAgent"](task)).toBe(true);
    expect(task.holdsSlot).toBe(false);
    expect(task.agent).toBeUndefined();
    expect(engine["checks"].preparingCount).toBe(1);
    expect(engine["checks"].claimPreparation("another-task")).toBe(false);
    engine["checks"].releasePreparation(task.id);
    expect(engine["checks"].claimPreparation("another-task")).toBe(true);
    engine["checks"].releasePreparation("another-task");
    engine.setPoolPaused(true);
    expect(engine["checks"].claimPreparation(task.id)).toBe(false);
    engine.s.backgroundAgents = [];
    task.state = "waiting";
    engine["driver"]["preparedTesters"].set(task.id, "already checked");
    engine.cancel(task.id);
    expect(engine["driver"]["preparedTesters"].has(task.id)).toBe(false);
  } finally { await engine.shutdown(); }
});

it("admits a queued planner while the check-preparation lane is full", async () => {
  const root = tempDir("petrina-planner-beside-checks-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   });
  engine.setPoolPaused(true);
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const check = engine.task(engine.addTask({ productId, title: "Waiting for checks", backlog: true }))!;
    Object.assign(check, { state: "waiting", startedAt: Date.now(), stageIndex: 0, plan: { rationale: "Review", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 }] } });
    const queued = engine.addTask({ productId, title: "Plan while checks wait" });
    engine.s.pool.limit = 1;
    const started: string[] = [];
    engine["driver"]["startDriver"] = (id) => { started.push(id); };
    engine.setPoolPaused(false);
    expect(started).toContain(queued);
    expect(engine["checks"].preparingCount).toBe(1);
  } finally { await engine.shutdown(); }
});

it("keeps shared check readiness independent of the active repository and invalidates changed evidence", async () => {
  const root = tempDir("petrina-shared-check-readiness-");
  roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null },  });
  engine.setPoolPaused(true);
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "Shared readiness", backlog: true }))!;
    task.repositories = [productId, "peer"].map((id, index) => ({ productId: id, delivery: "local", baseSha: `base-${id}`, checks: { at: 10 + index, current: true, results: [] }, completedStages: [] }));
    task.activeProductId = productId;
    const first = engine["driver"]["testerCheckKey"](task);
    task.activeProductId = "peer";
    expect(engine["driver"]["testerCheckKey"](task)).toBe(first);
    task.repositories[1]!.checks!.at += 1;
    expect(engine["driver"]["testerCheckKey"](task)).not.toBe(first);
    const changed = engine["driver"]["testerCheckKey"](task);
    task.activeProductId = productId;
    expect(engine["driver"]["testerCheckKey"](task)).toBe(changed);
    task.handChanges = true;
    expect(engine["driver"]["testerCheckKey"](task)).not.toBe(changed);
  } finally { await engine.shutdown(); }
});
