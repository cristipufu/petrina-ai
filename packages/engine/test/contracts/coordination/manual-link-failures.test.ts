import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, plant, settledSource } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("leaves a manual report untracked after copying or saving fails and safely retries with a fresh reference", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop);
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Manual target", backlog: true });
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "copy-failed" };
    const copy = spyOn(world.files, "copyFile").mockRejectedValue(new Error("Copy refused"));
    try {
      const result = await c.call("task.track-finding", args);
      expect(result.outcome).toBe("invalid");
      expect(result.message).toContain("pictures could not be copied");
    } finally { copy.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    expect(engine.task(targetId)!.followUp).toBeUndefined();
    expect((await c.call("task.track-finding", args)).outcome).toBe("invalid");
    const originalSave = engine.save.bind(engine);
    let saves = 0;
    const save = spyOn(engine, "save").mockImplementation((...args) => {
      if (saves++ === 0) throw new Error("Save refused");
      return originalSave(...args);
    });
    try {
      const result = await c.call("task.track-finding", { ...args, requestId: "save-failed" });
      expect(result.outcome).toBe("invalid");
      expect(result.message).toContain("Save refused");
    } finally { save.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    expect(engine.task(targetId)!.followUp).toBeUndefined();
    expect(engine.task(targetId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toEqual([]);
    expect((await c.call("task.track-finding", { ...args, requestId: "copy-retried" })).outcome).toBe("completed");
    expect(engine.task(targetId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toHaveLength(1);
    engine.task(targetId)!.state = "done";
    await engine["cleanup"].removeCaptures(targetId);
    expect(existsSync(join(engine.dataDir, "captures", targetId))).toBe(false);
    await engine["followUps"].beforeRemoval(engine.task(source.id)!);
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
  } finally { await shutdown(world.engine); }
});
