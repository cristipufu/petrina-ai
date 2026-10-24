import { expectRejection } from "./rejections.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { headroom, limitOf } from "@petrina/core";
import { Engine } from "./engine.js";
import { dispatch } from "../src/server.js";
import { removeDir, tempDir } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
async function fixture() {
  const root = tempDir("petrina-runtime-edges-"); roots.push(root);
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null } });
  await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
  engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "p", title: "A task", backlog: true }))!;
  return { engine, task };
}

it("waits for background work to settle without replaying an owner's handled rejection", async () => {
  const { engine } = await fixture();
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const success = new Promise<string>(resolve => { finish = resolve; });
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  const reason = new Error("A follow-up picture is still on the original task");
  const handled = failure.catch(error => error);
  try {
    expect(engine.trackWork(success)).toBe(success);
    expect(engine.trackWork(failure)).toBe(failure);
    expect(engine.backgroundWork.size).toBe(2);
    expect(engine.inFlight()).toBe(2);
    let settled = false;
    const waiting = Promise.all([...engine.backgroundWork]).then(() => { settled = true; });
    finish("Copied");
    expect(await success).toBe("Copied");
    expect(engine.backgroundWork.size).toBe(1);
    expect(engine.inFlight()).toBe(1);
    expect(settled).toBe(false);
    fail(reason);
    await waiting;
    expect(await handled).toBe(reason);
    expect(settled).toBe(true);
    expect(engine.backgroundWork.size).toBe(0);
    expect(engine.inFlight()).toBe(0);
  } finally {
    finish("Copied"); fail(reason);
    await Promise.allSettled([...engine.backgroundWork]);
    await engine.shutdown();
  }
});

it("surfaces the planned tool's login problem instead of a usage wait when no tool is usable", async () => {
  const { engine, task } = await fixture();
  try {
    engine.s.setup = { done: true, platform: "darwin", checks: (["claude-code", "codex", "grok", "antigravity"] as const).map(id => ({ id, status: "logged-out", at: Date.now() })) };
    const planned = engine.profile("opus-high")!;
    expect(engine.usableTools()).toEqual([]);
    expect(engine.choose(planned.id, task, "planner")).toEqual({ kind: "planned", profile: planned, reason: expect.stringContaining("No tool passed readiness checks") });
    engine.s.pool.limited = [{ toolId: planned.toolId, until: Date.now() + 60_000, reason: "Usage exhausted" }];
    expect(engine.choose(planned.id, task, "planner")?.kind).toBe("none");
  } finally { await engine.shutdown(); }
});

it("evicts only dirty archive entries without retiring live tasks during a details read", async () => {
  const { engine, task } = await fixture();
  try {
    const ids = Array.from({ length: 18 }, (_, index) => engine.addTask({ productId: "p", title: `History ${index}`, backlog: true }));
    for (const id of ids) engine.cancel(id);
    await engine["followUps"].catchUp(); await Promise.all([...engine.backgroundWork]); engine.save();
    for (const id of ids.slice(0, 16)) expect(engine.task(id)).toBeDefined();
    engine.save(false);
    task.state = "cancelled"; task.column = "done"; task.finishedAt = Date.now(); engine.commit(task);
    const liveBefore = engine.store.database.query("SELECT id FROM active_tasks ORDER BY id").all();
    const save = spyOn(engine.store, "save"), archive = spyOn(engine.store, "saveArchivedTask");
    try {
      expect(engine.taskDetails(ids[16]!)).toBeDefined();
      expect(save).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
      expect(engine.s.tasks.includes(task)).toBe(true);
      expect(engine.store.database.query("SELECT id FROM active_tasks ORDER BY id").all()).toEqual(liveBefore);
      const dirty = engine.task(ids[1]!)!;
      dirty.statusLine = "An archive edit"; engine.commit(dirty);
      // id 2 is now oldest; touch it through id 16 so the dirty entry becomes oldest again.
      for (const id of ids.slice(2, 17)) engine.task(id);
      const write = archive.mockImplementationOnce(() => { throw new Error("Disk full"); });
      expect(() => engine.task(ids[17]!)).toThrow("Disk full");
      write.mockRestore();
      expect(engine.task(ids[1]!)).toBe(dirty);
      for (const id of ids.slice(2, 17)) engine.task(id);
      expect(engine.task(ids[17]!)).toBeDefined();
      expect(engine.store.history.get(dirty.id)!.statusLine).toBe("An archive edit");
      expect(engine.s.tasks.includes(task)).toBe(true);
      engine.save(false);
      expect(engine.s.tasks.includes(task)).toBe(false);
      expect(engine.store.database.query("SELECT id FROM active_tasks WHERE id=?").get(task.id)).toBeNull();
      expect(engine.taskDetails(task.id)).toBeDefined();
    } finally { save.mockRestore(); archive.mockRestore(); }
  } finally { await engine.shutdown(); }
});

it("does not retry checkpoints or questions, and handles concurrent retries and replacement inbox items", async () => {
  const { engine, task } = await fixture();
  const check = spyOn(engine["tools"], "stillNotReady");
  const scheduled = spyOn(engine, "schedule");
  try {
    for (const kind of ["plan", "design", "delivery", "question", "permission", "screen"] as const) {
      const id = engine.raise(task, kind, "Keep this request", true);
      const item = engine.s.inbox.find(item => item.id === id)!;
      await engine.retry(id);
      expect(engine.s.inbox.find(entry => entry.id === id)).toBe(item);
      expect(task.state).toBe("needs-you");
      engine.s.inbox = engine.s.inbox.filter(entry => entry.id !== id);
    }
    expect(check).not.toHaveBeenCalled();
    // Ordinary requests release no check or delivery resource; raising them adds no scheduling pass.
    expect(scheduled).not.toHaveBeenCalled();
    const id = engine.raise(task, "stuck", "A tool stopped", false, { toolId: "codex" });
    let release!: (value: boolean) => void;
    check.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = engine.retry(id);
    const firstRelease = release;
    const second = engine.retry(id);
    firstRelease(false); release(false);
    await Promise.all([first, second]);
    expect(task.timeline.filter(entry => entry.text === "You asked to try again")).toHaveLength(1);
    const next = engine.raise(task, "stuck", "Check again", false, { toolId: "codex" });
    const pending = engine.retry(next);
    const index = engine.s.inbox.findIndex(entry => entry.id === next);
    engine.s.inbox[index] = { ...engine.s.inbox[index]!, kind: "delivery" };
    release(false); await pending;
    expect(engine.s.inbox.find(entry => entry.id === next)?.kind).toBe("delivery");
    expect(task.timeline.filter(entry => entry.text === "You asked to try again")).toHaveLength(1);
  } finally { check.mockRestore(); scheduled.mockRestore(); await engine.shutdown(); }
});

it("returns Retry failures to the command caller when approving a stuck request", async () => {
  const { engine, task } = await fixture();
  const id = engine.raise(task, "stuck", "Check the tool", false, { toolId: "codex" });
  const check = spyOn(engine["tools"], "stillNotReady").mockRejectedValue(new Error("Readiness failed"));
  try {
    await expectRejection(dispatch(engine, { name: "approve", args: [id] }), "Readiness failed");
    expect(engine.s.inbox.some(item => item.id === id)).toBe(true);
  } finally { check.mockRestore(); await engine.shutdown(); }
});

it("handles and logs rejected PR polls while keeping the background work registry drainable", async () => {
  const { engine } = await fixture();
  const poll = spyOn(engine["shipping"].monitor, "pollPullRequests").mockRejectedValue(new Error("Database unavailable"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    engine["pollPullRequests"]();
    await Promise.allSettled([...engine.backgroundWork]);
    expect(log).toHaveBeenCalledWith("Could not refresh pull requests:", expect.objectContaining({ message: "Database unavailable" }));
    expect(engine.backgroundWork.size).toBe(0);
    poll.mockResolvedValue(); engine["pollPullRequests"](); await Promise.all([...engine.backgroundWork]);
  } finally { poll.mockRestore(); log.mockRestore(); await engine.shutdown(); }
});

it("contains a step-clock save failure and lets the next clock checkpoint save again", async () => {
  const { engine, task } = await fixture();
  task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
  const save = spyOn(engine, "save").mockImplementationOnce(() => { throw new Error("Disk unavailable"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(log).toHaveBeenCalledWith("Could not save step times:", expect.objectContaining({ message: "Disk unavailable" }));
    expect(() => engine["checkpointStepTimes"]()).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.stepClock).toBeDefined();
  } finally { save.mockRestore(); log.mockRestore(); await engine.shutdown(); }
});

it("registers the periodic step-clock checkpoint separately from other 15-second timers", async () => {
  const callbacks: (() => void)[] = [], interval = globalThis.setInterval;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof globalThis.setInterval>) => {
    if (args[1] === 15_000) callbacks.push(args[0] as () => void);
    return interval(...args);
  }) as typeof globalThis.setInterval);
  let engine: Engine | undefined;
  try {
    ({ engine } = await fixture());
    const checkpoint = spyOn(engine as unknown as { checkpointStepTimes(): void }, "checkpointStepTimes");
    try {
      for (const callback of callbacks) callback();
      await engine.extraValidations.retryCleanup();
      expect(checkpoint).toHaveBeenCalledTimes(1);
    } finally { checkpoint.mockRestore(); }
  } finally { timer.mockRestore(); await engine?.shutdown(); }
});

it("checkpoints step times only while a clock is active and the engine is running", async () => {
  const { engine, task } = await fixture();
  const save = spyOn(engine, "save");
  try {
    engine["checkpointStepTimes"](); expect(save).not.toHaveBeenCalled();
    task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
    engine["checkpointStepTimes"](); expect(save).toHaveBeenCalledTimes(1);
    delete task.stepClock.since;
    engine["checkpointStepTimes"](); expect(save).toHaveBeenCalledTimes(1);
    await engine.shutdown(); save.mockClear();
    engine["checkpointStepTimes"](); expect(save).not.toHaveBeenCalled();
  } finally { save.mockRestore(); await engine.shutdown(); }
});

it("keeps clean archives out of general commits and eviction, while persisting decisions on archived offers", async () => {
  const { engine } = await fixture();
  const guarded: object[] = [];
  try {
    const ids = Array.from({ length: 18 }, (_, index) => engine.addTask({ productId: "p", title: `Old ${index}`, backlog: true }));
    for (const id of ids) engine.cancel(id);
    await engine["followUps"].catchUp(); await Promise.all([...engine.backgroundWork]); engine.save();
    for (const id of ids.slice(0, 16)) {
      const session = engine.task(id)!.session; guarded.push(session);
      Object.defineProperty(session, "toJSON", { configurable: true, value: () => { throw new Error("Clean archive was serialized"); } });
    }
    engine.commitNow(); // Settings/scheduling use untargeted commits.
    engine.commit();
    expect(engine.taskDetails(ids[16]!)).toBeDefined();
    for (const session of guarded) Reflect.deleteProperty(session, "toJSON"); guarded.length = 0;
    const old = engine.task(ids[17]!)!;
    for (const kind of ["learnings", "guide"] as const) for (const accept of [true, false]) {
      const id = engine.raise(old, kind, "An optional offer", false, { body: kind === "learnings" ? "- Use the focused repository check." : "Inspect neighboring cases." });
      old.state = "cancelled";
      if (accept) engine.approve(id); else engine.decline(id);
      engine.save(false);
      expect(engine.store.history.get(old.id)!.timeline.at(-1)).toEqual(old.timeline.at(-1));
      expect(engine.s.inbox.some(item => item.id === id)).toBe(false);
    }
    const id = engine.sendMessage(old.id, "A coordinator note", "queue", "archived-note");
    expect(engine.store.history.get(old.id)!.queued.some(message => message.id === id)).toBe(true);
    engine.removeQueued(old.id, id!);
    expect(engine.store.history.get(old.id)!.queued.some(message => message.id === id)).toBe(false);
  } finally { for (const session of guarded) Reflect.deleteProperty(session, "toJSON"); await engine.shutdown(); }
});

it("cancels screen handoff timers and ignores scheduling after shutdown during startup", async () => {
  const { engine, task } = await fixture();
  task.state = "waiting";
  task.screen = { reason: "A window", at: Date.now(), roleId: "builder", profileId: "sol-high", granted: true };
  let release: (() => void) | undefined;
  const actual = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 0 && typeof args[0] === "function") { const callback = args[0]; release = () => callback(); }
    return actual(...args);
  }) as typeof setTimeout);
  try { engine.releaseScreen(task); } finally { timeout.mockRestore(); }
  const schedule = spyOn(engine, "schedule"), screen = spyOn(engine, "syncScreen"), commit = spyOn(engine, "commitNow");
  try {
    expect(release).toBeDefined();
    await engine.shutdown();
    release!(); expect(schedule).not.toHaveBeenCalled();
    engine["startupComplete"] = false;
    engine.schedule();
    expect(screen).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  } finally { schedule.mockRestore(); screen.mockRestore(); commit.mockRestore(); await engine.shutdown(); }
});

it("starts available Antigravity models while Argon's weekly quota is exhausted", async () => {
  const { engine, task } = await fixture();
  engine.schedule = () => {};
  engine.s.profiles = engine.s.profiles.filter(profile => profile.toolId === "antigravity");
  const argon = engine.s.profiles.find(profile => profile.modelId?.includes("argon"))!;
  const flash = engine.s.profiles.find(profile => profile.modelId?.includes("flash"))!;
  engine.s.tools.forEach(tool => { tool.status = tool.id === "antigravity" ? "ready" : "not-installed"; });
  engine.s.setup!.checks = [{ id: "antigravity", status: "ready" }];
  engine.s.pool.limit = 8; engine.s.pool.toolCaps.antigravity = 4;
  engine.s.pool.paused = false; engine.draining = false;
  const until = Date.now() + 3_600_000;
  engine.recordUsage({ toolId: "antigravity", model: "argon", kind: "seven_day", status: "rejected", utilization: 1, resetsAt: until });
  engine.recordUsage({ toolId: "antigravity", model: "flash", kind: "seven_day", status: "allowed", utilization: 0, resetsAt: until });
  engine.recordUsage({ toolId: "antigravity", model: "flash", kind: "five_hour", status: "allowed", utilization: 0.01, resetsAt: until });
  const other = engine.task(engine.addTask({ productId: "p", title: "Other model", backlog: true }))!;
  for (const [index, entry] of [task, other].entries()) {
    entry.state = "waiting"; entry.stageIndex = 0;
    entry.plan = { rationale: "Build", plannerProfileId: flash.id, stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: [index ? flash.id : argon.id] }] };
  }
  const start = spyOn(engine["driver"], "startDriver").mockImplementation(() => {});
  try {
    engine["driver"].schedule();
    expect(start.mock.calls.map(args => args[0])).toEqual([task.id, other.id]);
    expect([task.agent?.profileId, other.agent?.profileId]).toEqual([flash.id, flash.id]);
    expect(engine.s.pool.limited?.every(limit => limit.model === "argon")).toBe(true);
  } finally { start.mockRestore(); await engine.shutdown(); }
});

it("replaces an account's old quota groups after a subscription change without clearing unrelated or retry limits", async () => {
  const { engine } = await fixture();
  const now = Date.now(), resetsAt = now + 3_600_000;
  const alpha = { id: "alpha", toolId: "provider", model: "Group Alpha", modelId: "group-alpha", effort: "high" as const };
  const report = (model: string, kind = "seven_day", utilization = 0.01) => ({ toolId: "provider", model, kind, name: model === "group" ? "Shared models" : model, utilization, status: utilization === 1 ? "rejected" as const : "allowed" as const, resetsAt });
  try {
    engine.recordUsage(report("alpha", "seven_day", 1));
    engine.recordUsage(report("beta"));
    engine.recordUsage({ toolId: "other", kind: "seven_day", status: "rejected", resetsAt });
    engine.s.pool.limited!.push({ toolId: "provider", retry: true, until: resetsAt, reason: "A refused request", at: now });
    engine.s.pool.limited!.push({ toolId: "provider", model: "gamma", until: resetsAt, reason: "A turn-only rate limit", at: now });
    engine.recordAccountUsage("provider", [report("group"), report("group", "five_hour", 0.03)]);
    expect(engine.s.pool.usage!.filter(entry => entry.toolId === "provider").map(entry => [entry.model, entry.kind])).toEqual([["group", "seven_day"], ["group", "five_hour"]]);
    expect(engine.s.pool.limited!.map(entry => [entry.toolId, entry.model, entry.retry])).toEqual([["other", undefined, undefined], ["provider", undefined, true], ["provider", "gamma", undefined]]);
    expect(headroom(engine.s.pool, alpha, now)).toBeGreaterThan(0);
    const saved = structuredClone(engine.s.pool);
    engine.recordAccountUsage("provider", []);
    engine.recordAccountUsage("provider", [{ toolId: "other", kind: "seven_day", status: "allowed" }]);
    expect(engine.s.pool).toEqual(saved);
    // A complete reading can retain a genuinely exhausted model without blocking its peers.
    engine.s.pool.limited = engine.s.pool.limited!.filter(entry => !entry.retry);
    engine.recordAccountUsage("provider", [report("alpha", "seven_day", 1), report("beta")]);
    expect(limitOf(engine.s.pool, alpha, now)?.model).toBe("alpha");
    expect(limitOf(engine.s.pool, { ...alpha, model: "Beta", modelId: "beta" }, now)).toBeUndefined();
    engine.recordAccountUsage("provider", [report("group"), report("group", "five_hour", 0.03)]);
    expect(limitOf(engine.s.pool, alpha, now)).toBeUndefined();
    engine.save();
    const persisted = engine.store.load()!.pool;
    expect(persisted.usage!.filter(entry => entry.toolId === "provider")).toEqual(engine.s.pool.usage!.filter(entry => entry.toolId === "provider"));
    expect(limitOf(persisted, alpha, now)).toBeUndefined();
    expect(persisted.limited!.some(entry => entry.toolId === "other")).toBe(true);
  } finally { await engine.shutdown(); }
});
