import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecordFixtures } from "../../fixtures/coordinator-records.js";
const owners = coordinatorRecordFixtures();
afterAll(() => owners.close());

it("evicts only dirty archive entries without retiring live tasks during a details read", async () => {
  return owners.use(async ({ engine, task, owner: lifetime }) => {

  try {
    const ids = Array.from({ length: 18 }, (_, index) => engine.addTask({ productId: "p", title: `History ${index}`, backlog: true }));
    for (const id of ids) engine.cancel(id);
    await engine["followUps"].catchUp(); await Promise.all([...engine.backgroundWork]); engine.save();
    for (const id of ids.slice(0, 16)) expect(engine.task(id)).toBeDefined();
    engine.save(false);
    task.state = "cancelled"; task.column = "done"; task.finishedAt = Date.now(); engine.commit(task);
    const liveBefore = engine.store.database.query("SELECT id FROM active_tasks ORDER BY id").all();
    lifetime.check();
    const save = spyOn(engine.store, "save");
    lifetime.onStop(() => save.mockRestore());
lifetime.check();
    const archive = spyOn(engine.store, "saveArchivedTask");
    lifetime.onStop(() => archive.mockRestore());
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
});

it("keeps clean archives out of general commits and eviction, while persisting decisions on archived offers", async () => {
  return owners.use(async ({ engine }) => {

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
});
