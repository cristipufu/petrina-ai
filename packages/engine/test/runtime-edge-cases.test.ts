import { afterAll, expect, it, spyOn } from "bun:test";
import { Engine } from "../src/engine.js";
import { dispatch } from "../src/server.js";
import { removeDir, tempDir } from "./support.js";

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
  } finally { check.mockRestore(); await engine.shutdown(); }
});

it("returns Retry failures to the command caller when approving a stuck request", async () => {
  const { engine, task } = await fixture();
  const id = engine.raise(task, "stuck", "Check the tool", false, { toolId: "codex" });
  const check = spyOn(engine["tools"], "stillNotReady").mockRejectedValue(new Error("Readiness failed"));
  try {
    await expect(dispatch(engine, { name: "approve", args: [id] })).rejects.toThrow("Readiness failed");
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
  const actual = globalThis.setInterval;
  let clock: (() => void) | undefined;
  const intervals = spyOn(globalThis, "setInterval").mockImplementation((...parameters: Parameters<typeof setInterval>) => {
    const [callback, milliseconds, ...args] = parameters;
    if (milliseconds === 15_000) clock = () => { if (typeof callback === "function") callback(...args); };
    return actual(...parameters);
  });
  let fixtureResult: Awaited<ReturnType<typeof fixture>>;
  try { fixtureResult = await fixture(); } finally { intervals.mockRestore(); }
  const { engine, task } = fixtureResult;
  task.stepClock = { roleId: "builder", repeat: false, worked: 0, since: Date.now() };
  const save = spyOn(engine, "save").mockImplementationOnce(() => { throw new Error("Disk unavailable"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(clock).toBeDefined();
    expect(() => clock!()).not.toThrow();
    expect(log).toHaveBeenCalledWith("Could not save step times:", expect.objectContaining({ message: "Disk unavailable" }));
    expect(() => clock!()).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.stepClock).toBeDefined();
  } finally { save.mockRestore(); log.mockRestore(); await engine.shutdown(); }
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
