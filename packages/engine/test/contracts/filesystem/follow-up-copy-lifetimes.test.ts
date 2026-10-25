import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { followUpKey } from "@petrina/core";
import { createFollowUpFixtures, older, taskOf, finish, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("keeps an unfinished source's picture while its report's link is copied, even when that task is cancelled", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-held: The coordinator's fix", backlog: true });
    engine.queueTask(fixId);
    const running = taskOf(engine, world.shop, "Still running", [older("early", "bug-held: Seen while its task runs")]);
    running.state = "running";
    plant(engine, running.id, running.findings[0]!.text);
    const original = join(engine.dataDir, "captures", running.id, "pic.png");
    const done = taskOf(engine, world.shop, "Finished", [older("late", "bug-held: The same bug, finished")]);
    const originalCopy = world.files.copyFile;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let copying!: () => void;
    const started = new Promise<void>(resolve => { copying = resolve; });
    const copy = spyOn(world.files, "copyFile").mockImplementation(async (...args) => { copying(); await held; return originalCopy(...args); });
    try {
      const finishing = finish(engine, done);
      await started;
      engine.cancel(running.id);
      await engine["cleanup"].removeCaptures(running.id);
      expect(existsSync(original)).toBe(true);
      release();
      await finishing;
    } finally { release(); copy.mockRestore(); }
    const fix = engine.task(fixId)!;
    expect(fix.followUp!.reports.map(report => report.findingId).sort()).toEqual(["early", "late"]);
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: running.id, imageId: "pic" }]);
    expect(engine.task(running.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    await engine["cleanup"].removeCaptures(running.id);
    expect(existsSync(original)).toBe(false);
  } finally { await shutdown(world.engine); }
});

it("keeps a saved link and its picture when the manual fix finishes or is cancelled during the copy, then follows the closed-target rules", async () => {
  const world = await open();
  const { engine } = world;
  try {
    for (const [end, copied] of [["finish", true], ["cancel", true], ["finish", false]] as const) {
      const label = `${end}${copied ? "copied" : "refused"}`;
      const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: `bug-${label}: The coordinator's fix`, description: "The unchanged request", backlog: true });
      engine.queueTask(fixId);
      const fix = engine.task(fixId)!;
      const source = taskOf(engine, world.shop, `Copying while the fix ends: ${end}`, [older("old", `bug-${label}: A later sighting`)]);
      plant(engine, source.id, source.findings[0]!.text);
      const key = followUpKey(source.id, "old");
      const original = join(engine.dataDir, "captures", source.id, "pic.png");
      const originalCopy = world.files.copyFile;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let copying!: () => void;
      const started = new Promise<void>(resolve => { copying = resolve; });
      const copy = spyOn(world.files, "copyFile").mockImplementation(async (...args) => {
        copying();
        await held;
        if (!copied) throw new Error("Copy refused");
        return originalCopy(...args);
      });
      try {
        const finishing = finish(engine, source);
        await started;
        // The destination and the report were saved before copying began.
        expect(fix.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
        expect(engine.s.followUpPending).toContainEqual({ keys: [key], cardId: fixId });
        if (end === "finish") Object.assign(fix, { state: "done", column: "done", finishedAt: Date.now() });
        else engine.cancel(fixId);
        fix.session.push({ id: `during-${label}`, from: "agent", text: "Activity while the copy runs", at: Date.now() });
        // Both tasks stay on the board, with their pictures, while the link is saved.
        engine.save();
        expect([engine.s.tasks.includes(fix), engine.s.tasks.includes(source)]).toEqual([true, true]);
        await engine["cleanup"].removeCaptures(source.id);
        await engine["cleanup"].removeCaptures(fixId);
        expect(existsSync(original)).toBe(true);
        expect(existsSync(join(engine.dataDir, "captures", fixId))).toBe(true);
        release();
        await finishing;
      } finally { release(); copy.mockRestore(); }
      const after = engine.task(fixId)!;
      expect(after.state).toBe(end === "finish" ? "done" : "cancelled");
      expect(after.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
      expect(after.session.some(line => line.id === `during-${label}`)).toBe(true);
      expect(after.session.flatMap(line => line.images ?? [])).toHaveLength(copied ? 1 : 0);
      expect(engine.task(source.id)!.findings[0]!.tracking).toEqual(copied ? { taskId: fixId } : { reason: "pictures", retry: true });
      expect(engine.s.followUpPending).toEqual(copied ? [] : [{ keys: [key], cardId: fixId }]);
      // Released, the closed fix leaves the board. Recovery neither reopens it nor opens another card, and
      // the original picture goes with the source's cleanup, as for any finished or cancelled destination.
      engine.save();
      expect(engine.s.tasks.some(task => task.id === fixId)).toBe(false);
      await engine["followUps"].catchUp();
      expect(cardFor(engine, label)).toEqual([]);
      expect(engine.task(fixId)!.state).toBe(after.state);
      expect(engine.task(fixId)!.followUp!.reports).toHaveLength(1);
      await engine["cleanup"].removeCaptures(source.id);
      await engine["cleanup"].removeCaptures(fixId);
      expect([existsSync(original), existsSync(join(engine.dataDir, "captures", fixId))]).toEqual([false, false]);
    }
    expect(world.prompts).toHaveLength(3);
  } finally { await shutdown(world.engine); }
});
