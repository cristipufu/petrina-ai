import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Aborted } from "../src/kernel.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("tasks' checks take turns on one machine", () => {
  for (const checkRuns of [1, 2]) it(`hands a released place to the waiting task before a new arrival (limit ${checkRuns})`, async () => {
    const root = tempDir("petrina-check-handoff-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { codexCommand: null, checkRuns });
    engine.setPoolPaused(true);
    const held: (() => void)[] = [];
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const task = engine.task(engine.addTask({ productId, title: "A check waiting its turn" }))!;
      const acquire = () => engine["checks"]["turnToRun"](task, new AbortController().signal);
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
    const engine = new Engine(join(root, "data"), { codexCommand: null });
    engine.setPoolPaused(true);
    const held: (() => void)[] = [];
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const task = engine.task(engine.addTask({ productId, title: "A cancelled check" }))!;
      const acquire = (signal = new AbortController().signal) => engine["checks"]["turnToRun"](task, signal);
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
    let waited = false;
    let waitingStep: { taskId: string; stepId: string; startedAt: number } | undefined;
    const unsubscribe = engine.subscribe(() => {
      const task = engine.getState().tasks.find((task) => task.statusLine === "Waiting to run the checks: another task's run comes first");
      if (task) {
        waited = true;
        if (!waitingStep) {
          // Admission reserves a place before opening the diagnostic log and reporting start.
          // Wait for that report before comparing a running check with its queued peer.
          const running = engine.getState().tasks.flatMap((entry) => entry.journey?.at(-1)?.productChecks ?? []).find((check) => check.result === "running");
          if (!running) return;
          const step = task.journey!.at(-1)!;
          expect(step).toMatchObject({ kind: "petrina", work: "checks" });
          expect(step.endedAt).toBeUndefined();
          expect(step.productChecks).toEqual([expect.objectContaining({ name: "Held check", result: "pending" })]);
          expect(running?.name).toBe("Held check");
          expect(running?.startedAt).toBeNumber();
          waitingStep = { taskId: task.id, stepId: step.id, startedAt: step.startedAt };
          // The first check is held until the other task is really waiting, then both run.
          rmSync(hold, { force: true });
        }
      }
    });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const ids = [engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" }), engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" })];
      await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        const tasks = ids.map((id) => state.tasks.find((entry) => entry.id === id) as Task | undefined);
        if (tasks.some((task) => task?.state === "failed")) throw new Error("a task failed");
        return ids.every((id) => state.inbox.some((item) => item.taskId === id && item.kind === "delivery"));
      }, "both delivery checks", 90_000);
      expect(waited).toBe(true);
      const task = engine.getState().tasks.find((task) => task.id === waitingStep!.taskId)!;
      expect(task.journey!.find((step) => step.id === waitingStep!.stepId)).toMatchObject({ startedAt: waitingStep!.startedAt, end: "done", outcome: "The check passes" });
      for (const task of engine.getState().tasks) expect(journeyProblems(task)).toEqual([]);
      const checked = new Set(readFileSync(runs, "utf8").trim().split("\n").map((path) => realpathSync.native(path)));
      const copies = new Set(ids.map((id) => realpathSync.native(engine.getState().tasks.find((task) => task.id === id)!.worktree!)));
      expect(checked).toEqual(copies);
    } finally {
      unsubscribe();
      rmSync(hold, { force: true });
      await engine.shutdown();
    }
  });
});
