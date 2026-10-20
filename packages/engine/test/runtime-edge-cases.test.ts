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
