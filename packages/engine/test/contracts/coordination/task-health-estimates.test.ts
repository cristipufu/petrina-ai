import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  finishedTask,
  reviewStats,
  timeLeft,
  type HistoryMetadata,
  type State,
  type StepRecord,
  type Task,
} from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { Coordination } from "../../../src/coordination.js";
import type { Engine } from "../../engine.js";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

function task(id: string, changes: Partial<Task> = {}): Task {
  return {
    id,
    productId: "product",
    title: "Health",
    description: "",
    area: "work",
    kind: "feature",
    priority: 0,
    held: false,
    state: "running",
    column: "building",
    holdsSlot: true,
    approvePlan: false,
    delivery: "local",
    approveDelivery: false,
    stageIndex: 0,
    rounds: {},
    sub: 0,
    fixing: false,
    statusLine: "Testing",
    createdAt: NOW - 3 * MINUTE,
    timeline: [],
    session: [],
    queued: [],
    objections: [],
    findings: [],
    stepClock: { roleId: "tester", repeat: false, worked: MINUTE, since: NOW - MINUTE },
    ...changes,
  };
}

const record = (minutes = 12, at = NOW - 10 * MINUTE, roleId = "tester", repeat = false): StepRecord => ({
  roleId,
  repeat,
  worked: minutes * MINUTE,
  at,
});

const metadata = (steps: readonly StepRecord[], revision = 1): HistoryMetadata => ({
  revision,
  total: 1,
  products: [],
  reviews: reviewStats([]),
  reviewsByProduct: {},
  steps,
});

/** The real coordination read; by default no database, and never an engine, native services or archive bodies. */
function fixture(live: readonly StepRecord[] = [], archived: readonly StepRecord[] = [], store?: Store) {
  clock = spyOn(Date, "now").mockReturnValue(NOW);
  const current = task("current");
  const state: State = {
    now: NOW - MINUTE,
    seq: 0,
    products: [],
    roles: [],
    tools: [],
    profiles: [],
    tasks: [current, task("live", { steps: live })],
    inbox: [],
    pool: { limit: 1, paused: false, toolCaps: {} },
  };
  const archive = { info: metadata(archived), reads: 0, ids: new Set<string>(), lookups: [] as string[] };
  const forbidden = () => {
    throw new Error("Health must not load complete history, task bodies, query storage or change work");
  };
  const engine = {
    activeState: () => state,
    taskDetails: (id: string) => (id === current.id ? current : forbidden()),
    getState: forbidden,
    windowState: forbidden,
    save: forbidden,
    schedule: forbidden,
    retryTask: forbidden,
    cancelTask: forbidden,
    store: store ?? {
      database: { run: () => {}, query: forbidden },
      history: {
        info: () => {
          archive.reads++;
          return archive.info;
        },
        has: (id: string) => {
          archive.lookups.push(id);
          return archive.ids.has(id);
        },
        all: forbidden,
        get: forbidden,
        page: forbidden,
      },
    },
  } as unknown as Engine;
  const coordination = new Coordination(engine);
  const health = () => coordination.call("task.health", { taskId: current.id });
  const appEstimate = () =>
    timeLeft({ tasks: state.tasks.filter((entry) => !finishedTask(entry)), now: NOW, history: archive.info }, current);
  return { current, state, archive, health, appEstimate };
}

describe("coordinator health estimates", () => {
  it("agrees with the shared rule for archive-only, live-only and mixed samples", async () => {
    const samples = [record(10, 1), record(12, 2), record(14, 3)];
    for (const split of [3, 0, 1, 2]) {
      const f = fixture(samples.slice(split), samples.slice(0, split));
      try {
        const before = structuredClone(f.state);
        expect(await f.health()).toMatchObject({
          outcome: "completed",
          observedAt: NOW,
          workedMs: 2 * MINUTE,
          estimate: { text: "About 10 minutes left" },
        });
        expect((await f.health()).estimate).toMatchObject({
          text: f.appEstimate(),
          basis: expect.stringContaining("never a threshold"),
        });
        expect(f.archive.reads).toBe(2);
        expect(f.archive.lookups).toEqual([]);
        expect(f.state).toEqual(before);
      } finally {
        clock?.mockRestore();
      }
    }
  });

  it("counts finished tasks retained for cleanup only through their archived metadata", async () => {
    const f = fixture([record(12)], [record(30)]);
    // Saved terminal tasks can still be in activeState while their cleanup settles.
    f.state.tasks = [...f.state.tasks, task("cleanup", { state: "done", steps: [record(30)] })];
    f.archive.ids.add("cleanup");
    expect((await f.health()).estimate).toBeNull(); // Two real samples, not three.
    f.archive.info = metadata([record(4), record(30)], 2);
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
    f.state.tasks = f.state.tasks.filter((entry) => entry.id !== "cleanup");
    expect((await f.health()).estimate).toMatchObject({ text: f.appEstimate() });
  });

  it("uses the latest ten across both populations before taking their median", async () => {
    const old = Array.from({ length: 10 }, (_, index) => record(60, index));
    const recent = Array.from({ length: 10 }, (_, index) => record(12, 100 + index));
    const f = fixture([...recent.slice(5), ...old], recent.slice(0, 5));
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
  });

  it("requires three samples of the exact role and first-or-repeat pass", async () => {
    const f = fixture(
      [record()],
      [
        record(),
        ...Array.from({ length: 3 }, () => record(60, 1, "builder")),
        ...Array.from({ length: 3 }, () => record(30, 2, "tester", true)),
      ],
    );
    expect((await f.health()).estimate).toBeNull();
    f.current.stepClock = { roleId: "tester", repeat: true, worked: 2 * MINUTE, since: NOW };
    expect((await f.health()).estimate).toMatchObject({ text: "About 30 minutes left" });
    f.current.stepClock = { roleId: "builder", repeat: false, worked: 2 * MINUTE, since: NOW };
    expect((await f.health()).estimate).toMatchObject({ text: "About an hour left" });
    f.current.stepClock = { roleId: "custom-tester", repeat: false, worked: 0, since: NOW };
    expect((await f.health()).estimate).toBeNull();
    f.archive.info = metadata(
      Array.from({ length: 3 }, () => record(12, 1, "custom-tester")),
      2,
    );
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
  });

  it("excludes waits and stopped clocks, and keeps working time and overdue wording", async () => {
    const f = fixture([], [record(), record(), record()]);
    for (const state of [
      "paused",
      "waiting",
      "needs-you",
      "queued",
      "failed",
      "backlog",
      "done",
      "cancelled",
    ] as const) {
      f.current.state = state;
      expect((await f.health()).estimate).toBeNull();
    }
    f.current.state = "running";
    f.current.stepClock = { roleId: "tester", repeat: false, worked: 2 * MINUTE };
    expect((await f.health()).estimate).toBeNull();
    f.current.stepClock = undefined;
    expect((await f.health()).estimate).toBeNull();
    // Only one minute since resuming is added to the saved minute of work.
    f.current.stepClock = { roleId: "tester", repeat: false, worked: MINUTE, since: NOW - MINUTE };
    expect(await f.health()).toMatchObject({ workedMs: 2 * MINUTE, estimate: { text: "About 10 minutes left" } });
    f.current.stepClock.worked = 12 * MINUTE;
    expect((await f.health()).estimate).toMatchObject({ text: "Taking longer than usual" });
  });

  it("sees newly archived and updated timing metadata on the next read", async () => {
    const f = fixture([record(), record()], []);
    expect((await f.health()).estimate).toBeNull();
    const finished = task("newly-finished", { state: "cancelled", steps: [record()] });
    f.state.tasks = [...f.state.tasks, finished];
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
    f.archive.info = metadata(finished.steps!, 2);
    f.archive.ids.add(finished.id);
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
    f.state.tasks = [f.current];
    f.archive.info = metadata([record(), record(), record()], 3);
    expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
    f.archive.info = metadata([record(30), record(30), record(30)], 4);
    expect((await f.health()).estimate).toMatchObject({ text: "About 30 minutes left" });
    f.archive.info = metadata([record(30), record(30)], 5);
    expect((await f.health()).estimate).toBeNull();
    expect(f.archive.reads).toBe(6);
  });

  for (const outcome of ["done", "cancelled"] as const) {
    it(`keeps a newly ${outcome} task's samples through pending, failed and successful saves`, async () => {
      const store = new Store(":memory:");
      const forbidden = () => {
        throw new Error("Health must not read archived bodies or the complete history");
      };
      const all = spyOn(store.history, "all").mockImplementation(forbidden);
      const get = spyOn(store.history, "get").mockImplementation(forbidden);
      try {
        const f = fixture([], [], store);
        const cleanup = task("cleanup", { state: "done", steps: [record(4), record(12)], stepClock: undefined });
        const finishing = task("finishing");
        f.state.tasks = [f.current, cleanup, finishing];
        // Keep the saved finished body live, as the engine does while cleanup settles.
        store.save(f.state, []);
        expect((await f.health()).estimate).toBeNull();
        finishing.state = outcome;
        finishing.steps = [record(30)];
        finishing.stepClock = undefined;
        expect(store.history.has(finishing.id)).toBe(false);
        expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });

        // The failed transaction must leave the same unsaved live sample available.
        store.database.run(
          "CREATE TRIGGER reject_snapshot BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'snapshot refused'); END",
        );
        f.state.seq++;
        expect(() => store.save(f.state, [])).toThrow("snapshot refused");
        expect(store.history.has(finishing.id)).toBe(false);
        expect((await f.health()).estimate).toMatchObject({ text: "About 10 minutes left" });
        store.database.run("DROP TRIGGER reject_snapshot");
        store.save(f.state, []);
        expect(store.history.has(finishing.id)).toBe(true);
        expect(store.history.info().steps).toHaveLength(3);
        const afterSave = await f.health();
        expect(afterSave.estimate).toMatchObject({ text: "About 10 minutes left" });
        expect(afterSave.estimate).toMatchObject({
          text: timeLeft({ tasks: [f.current], now: NOW, history: store.history.info() }, f.current),
        });
        f.state.tasks = [f.current];
        expect((await f.health()).estimate).toEqual(afterSave.estimate);
        expect(all).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      } finally {
        all.mockRestore();
        get.mockRestore();
        store.close();
      }
    });
  }

  it("preserves check activity, waiting reasons and individual participant facts", async () => {
    const f = fixture([], [record(), record(), record()]);
    f.current.journey = [
      { id: "checks", kind: "agent", roleId: "tester", startedAt: NOW - 3 * MINUTE, round: 1, sub: 0 },
    ];
    f.current.todo = "Checking the nearby cases";
    f.current.toolActivity = {
      actionCount: 4,
      lastActivity: "Ran the tests",
      runningTool: { id: "check", description: "Running the tests", startedAt: NOW - 1_000 },
    };
    f.current.helpers = [
      { roleId: "code-reviewer", profileId: "reviewer", reviewKey: "1", since: NOW - MINUTE, step: 0 },
    ];
    f.current.hunt = {
      stageId: "review",
      round: 1,
      reported: { "0": true },
      work: {
        "1": {
          attempts: 2,
          clock: { roleId: "code-reviewer", repeat: false, worked: MINUTE },
          todo: "Checking the outcome",
          waiting: "Your answer",
          toolActivity: { actionCount: 3, lastActivity: "Read the request" },
        },
      },
    };
    const facts = {
      node: { id: "checks", kind: "agent", elapsedMs: 3 * MINUTE, ended: false },
      todo: "Checking the nearby cases",
      actionCount: 4,
      lastActivity: "Ran the tests",
      lastObservedAt: NOW - 1_000,
      runningTool: { description: "Running the tests", startedAt: NOW - 1_000 },
      seats: [
        {
          seat: "1",
          roleId: "code-reviewer",
          profileId: "reviewer",
          workedMs: MINUTE,
          working: false,
          attempts: 2,
          waiting: "Your answer",
          todo: "Checking the outcome",
          lastActivity: "Read the request",
          actionCount: 3,
          runningTool: null,
        },
      ],
    };
    expect(await f.health()).toMatchObject({
      ...facts,
      working: true,
      waitingReason: null,
      estimate: { text: "About 10 minutes left" },
    });
    f.current.state = "needs-you";
    f.current.statusLine = "Waiting for your answer";
    f.current.stepClock = { roleId: "tester", repeat: false, worked: 2 * MINUTE };
    expect(await f.health()).toMatchObject({
      ...facts,
      working: false,
      waitingReason: "Waiting for your answer",
      estimate: null,
    });
    // Petrina's own check step has no working agent clock or estimate.
    f.current.state = "running";
    f.current.stepClock = undefined;
    f.current.journey = [{ id: "checks", kind: "petrina", work: "checks", startedAt: NOW - 3 * MINUTE, round: 1, sub: 0 }];
    expect(await f.health()).toMatchObject({
      ...facts,
      node: { ...facts.node, kind: "petrina" },
      working: false,
      workedMs: null,
      waitingReason: null,
      estimate: null,
    });
  });
});
