import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, mainLine, timeLeft, workedSoFar, type State, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Store } from "@petrina/storage/store";
import { engineProcesses, type EngineProcess, type EngineProcesses, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
const lifetimes = new Set<EngineProcesses>();
afterAll(async () => { await completeAll([...lifetimes].map(owners => owners.close())); roots.forEach(removeDir); });

const ITEM = "Drafting the greeting file";

/** A product delivering locally with no checks, a small task on it, and an engine on fake agents whose builder keeps a to-do list. */
async function start(reopen?: "load", clock = false, activity?: "grok") {
  const root = tempDir("petrina-todo-");
  const owners = engineProcesses(root); lifetimes.add(owners);
  const use = async <T>(body: () => Promise<T>): Promise<T> => {
    const value = await setupWithCleanup(() => owners.prepare(body), () => owners.close());
    await owners.close(); lifetimes.delete(owners); return value;
  };
  return setupWithCleanup(() => owners.prepare(async () => {
    const product = await makeProduct(root);
    const home = join(root, "home");
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "short", builder: "todo", ...(reopen ? { reopen } : {}), ...(activity ? { activity } : {}) });
    const clockFile = join(fakes.dir, "clock.txt");
    if (clock) writeFileSync(clockFile, "0");
    let current: EngineProcess | undefined;
    const launch = async () => {
      if (current) await owners.stop(current);
      current = await (clock ? owners.app(home, [join(import.meta.dir, "../../clock-harness.ts"), home, fakes.dir, clockFile]) : owners.harness(home, fakes.dir));
      return current;
    };
    const engine = await launch();
    const productId = (await owners.run(engine, async () => engine.act("addProduct", product))) as string;
    await owners.run(engine, async () => engine.act("setProductDelivery", productId, "local", false));
    const taskId = (await owners.run(engine, async () => engine.act("addTask", { productId, title: "Add a greeting" }))) as string;
    const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
    const go = (name: string) => writeFileSync(join(fakes.dir, name), "go");
    return { product, home, fakes, engine, owners, use, taskId, find, go, clockFile, launch };
  }), () => owners.close());
}

describe("the agent's to-do item", () => {
  for (const reopen of [undefined, "load"] as const) {
    it(`stays while tool activity changes, survives a restart ${reopen ? "with a replayed conversation" : "with a fresh conversation"}, and goes when the step ends`, async () => {
      // The replayed case also exercises Grok's native calls, which carry their kind only in metadata.
      const run = await start(reopen, false, reopen ? "grok" : undefined);
      return run.use(async () => {
        const owners = run.owners;

        let engine = run.engine;
        await waitFor(() => run.fakes.marked("builder-todo"), "the builder to start on its to-do list");
        const working = run.find(await owners.run(engine, async () => engine.until((state) => run.find(state).statusLine === "Continuing work", "the builder's latest action")));
        // The first item in progress, as plain text; the latest action is the status line, and neither overwrote the other.
        expect(working.todo).toBe(ITEM);
        expect(working.state).toBe("running");
        expect(working.toolActivity).toEqual(expect.objectContaining({ actionCount: reopen ? 4 : 2, lastActivity: "Reading the code" }));
        expect(working.toolActivity!.runningTool).toBeUndefined();
        const activityStep = working.journey!.find(step => step.toolActivity?.builder);
        expect(activityStep!.toolInvocations).toHaveLength(reopen ? 4 : 2);
        expect(activityStep!.toolInvocations!.every(call => call.status === "completed")).toBe(true);
        expect(mainLine(working)).toBe(ITEM);
        expect(working.session.filter((line) => line.from === "activity").map((line) => line.text)).toEqual(reopen
          ? ["Searching the code", "Reading notes.txt", "Running the tests", "Reading the code"]
          : ["Editing notes.txt", "Reading the code"]);
        // The timeline lists the item once.
        expect(working.timeline.filter((entry) => entry.text === ITEM)).toHaveLength(1);
        expect(working.stepClock).toMatchObject({ roleId: "builder", repeat: false });

        // A forced kill in the middle of the step: the item is on disk.
        await engine.kill();
        const store = new Store(join(run.home, "petrina.db"));
        expect(store.load()!.tasks.find((task) => task.id === run.taskId)!.todo).toBe(ITEM);
        store.close();

        // A fresh conversation after the restart shows the old item until the new agent names its own.
        engine = await owners.harness(run.home, run.fakes.dir);
        await waitFor(() => run.fakes.marked("builder-back"), "the builder to start the step again");
        const back = run.find(await owners.run(engine, async () => engine.state()));
        expect(back.state).toBe("running");
        expect(back.todo).toBe(ITEM);
        expect(mainLine(back)).toBe(ITEM);
        expect(back.steps).toEqual(working.steps);
        expect(back.toolActivity?.runningTool).toBeUndefined();
        run.go("go-todo");
        await owners.run(engine, async () => engine.until((state) => run.find(state).todo === "Finishing the greeting", "the new agent's own item"));
        run.go("go-finish");

        const done = run.find(await owners.run(engine, async () => engine.until((state) => run.find(state).state === "done", "the task to finish", 60_000)));
        expect(done.todo).toBeUndefined();
        expect(done.stepClock).toBeUndefined();
        // The restarted build left no record; every other agent's step did, as a first pass. Petrina commits to main itself.
        expect(done.steps?.map((record) => [record.roleId, record.repeat])).toEqual([
          ["planner", false],
          ["code-reviewer", false],
        ]);
        expect(await git(run.product, "show", "main:greeting.txt")).toBe("Hello");
        await engine.quit();
        const saved = new Store(join(run.home, "petrina.db"));
        expect(run.find(saved.load()!).steps).toEqual(done.steps);
        saved.close();

      });
    });
  }

  it("goes when the coordinator pauses, and the step that starts again leaves no record", async () => {
    const run = await start();
    return run.use(async () => {
      const owners = run.owners;

      await waitFor(() => run.fakes.marked("builder-todo"), "the builder to start on its to-do list");
      await owners.run(run.engine, async () => run.engine.until((state) => run.find(state).todo === ITEM, "the builder's to-do item"));
      await owners.run(run.engine, async () => run.engine.act("pause", run.taskId));
      const paused = run.find(await owners.run(run.engine, async () => run.engine.state()));
      expect(paused.todo).toBeUndefined();
      expect(paused.statusLine).toBe("Paused by you");
      await owners.run(run.engine, async () => run.engine.act("resume", run.taskId));
      const done = run.find(await owners.run(run.engine, async () => run.engine.until((state) => run.find(state).state === "done", "the task to finish", 60_000)));
      expect(done.steps?.map((record) => record.roleId)).toEqual(["planner", "code-reviewer"]);
      await run.engine.quit();

    });
  });

  it("keeps quiet working time through an ordinary quit and clears the item on cancellation", async () => {
    const run = await start();
    return run.use(async () => {
      const owners = run.owners;

      await waitFor(() => run.fakes.marked("builder-todo"), "the builder to start on its to-do list");
      const before = run.find(await owners.run(run.engine, async () => run.engine.until((state) => run.find(state).todo === ITEM, "the builder's to-do item")));
      // No new activity is saved during this stretch of work.
      await Bun.sleep(150);
      await run.engine.quit();
      const store = new Store(join(run.home, "petrina.db"));
      const saved = run.find(store.load()!);
      store.close();
      expect(saved.todo).toBe(ITEM);
      expect(saved.stepClock?.since).toBeUndefined();
      expect(saved.stepClock!.worked).toBeGreaterThanOrEqual(before.stepClock!.worked + 150);

      const engine = await owners.harness(run.home, run.fakes.dir);
      await waitFor(() => run.fakes.marked("builder-back"), "the builder to get back to work");
      await owners.run(engine, async () => engine.act("cancel", run.taskId));
      const cancelled = run.find(await owners.run(engine, async () => engine.state()));
      expect(cancelled.todo).toBeUndefined();
      expect(cancelled.stepClock).toBeUndefined();
      expect(mainLine(cancelled)).toBe("Cancelled");
      expect(cancelled.steps?.some((record) => record.roleId === "builder")).toBe(false);
      await engine.quit();

    });
  });
});

describe("the record each finished step leaves", () => {
  it("keeps elapsed work and its estimate through forced restarts, including quiet work, without counting time offline", async () => {
    const run = await start(undefined, true);
    return run.use(async () => {
      const owners = run.owners;

      const MINUTE = 60_000;
      let engine = run.engine;
      let alive = true;
      const store = new Store(join(run.home, "petrina.db"));
      try {
        await waitFor(() => run.fakes.marked("builder-todo"), "the builder to work quietly");
        await owners.run(engine, async () => engine.act("setPoolPaused", true));
        writeFileSync(run.clockFile, String(10 * MINUTE));
        // This immediate save used to write the previous snapshot's time.
        await owners.run(engine, async () => engine.act("sendMessage", run.taskId, "Keep the greeting short", "queue"));
        const saved = store.load()!;
        expect(workedSoFar(run.find(saved).stepClock!, saved.now)).toBeGreaterThanOrEqual(10 * MINUTE);
        await engine.kill(); alive = false;
        store.save({ ...saved, tasks: saved.tasks.map((task) => task.id === run.taskId ? { ...task, steps: [...(task.steps ?? []), ...[1, 2, 3].map((at) => ({ roleId: "builder", repeat: false, worked: 60 * MINUTE, at }))] } : task) });

        engine = await run.launch(); alive = true;
        expect(run.find(await owners.run(engine, async () => engine.state())).stepClock!.worked).toBeGreaterThanOrEqual(10 * MINUTE);
        await owners.run(engine, async () => engine.act("setPoolPaused", false));
        await waitFor(() => run.fakes.marked("builder-back"), "the builder to pick up its step");
        await owners.run(engine, async () => engine.act("setPoolPaused", true));
        await waitFor(() => store.load()!.pool.paused, "the last ordinary save before quiet work");
        // No plan update, tool call or coordinator action follows this advance: only the quiet checkpoint can save it.
        const advancedAt = Date.now() + 30 * MINUTE;
        writeFileSync(run.clockFile, String(30 * MINUTE));
        const checkpoint = await waitFor(() => {
          const state = store.load()!;
          return state.now >= advancedAt ? state : undefined;
        }, "quiet work to be checkpointed", 25_000);
        expect(workedSoFar(run.find(checkpoint).stepClock!, checkpoint.now)).toBeGreaterThanOrEqual(30 * MINUTE);
        await engine.kill(); alive = false;
        // Petrina is offline for six hours; none of that belongs to the agent's work.
        writeFileSync(run.clockFile, String((6 * 60 + 30) * MINUTE));
        engine = await run.launch(); alive = true;
        const recovered = run.find(await owners.run(engine, async () => engine.state()));
        expect(recovered.stepClock!.worked).toBeGreaterThanOrEqual(30 * MINUTE);
        expect(recovered.stepClock!.worked).toBeLessThan(35 * MINUTE);
        await owners.run(engine, async () => engine.act("setPoolPaused", false));
        const state = await owners.run(engine, async () => engine.until((state) => {
          const task = run.find(state);
          return task.state === "running" && task.stepClock?.since !== undefined;
        }, "the builder to resume its clock"));
        expect(timeLeft(state, run.find(state))).toBe("About 30 minutes left");
        await owners.run(engine, async () => engine.act("cancel", run.taskId));
      } finally {
        if (alive) await engine.quit();
        store.close();
      }

    });
  });

  it("names the role and the pass, and leaves out the time spent waiting for the coordinator", async () => {
    const root = tempDir("petrina-steps-");
    roots.push(root);
    const repo = await makeProduct(root);
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts")] });
    try {
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [no-check]" });
      const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)! as Task;
      // Every question and permission waits a while for its answer: none of that counts as work.
      const WAIT = 1_200;
      const answered = new Set<string>();
      await waitFor(
        async () => {
          for (const item of engine.getState().inbox.filter((entry) => !answered.has(entry.id))) {
            answered.add(item.id);
            expect(task().stepClock?.since).toBeUndefined();
            await Bun.sleep(WAIT);
            if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
            else engine.allow(item.id, "once");
          }
          return ["done", "failed"].includes(task().state);
        },
        "the task to finish",
        60_000,
      );
      const done = task();
      expect(done.error).toBeUndefined();
      expect(answered.size).toBe(2);
      // Each reviewer leaves its own record, even when they look at the change at once.
      expect(done.steps?.map((record) => record.roleId)).toEqual(["planner", "architect", "design-reviewer", "builder", "code-reviewer", "code-reviewer"]);
      expect(done.steps?.every((record) => !record.repeat)).toBe(true);
      // From the agent's start to its result, minus the wait for the coordinator.
      const span = (roleId: string) => {
        const step = done.journey!.find((entry) => entry.roleId === roleId)!;
        return step.endedAt! - step.startedAt;
      };
      for (const roleId of ["architect", "builder"]) {
        const record = done.steps!.find((entry) => entry.roleId === roleId)!;
        expect(record.worked).toBeLessThan(span(roleId) - WAIT + 300);
        expect(record.worked).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await engine.shutdown();
    }
  });
});
