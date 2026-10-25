import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { followUpKey } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, plant, settledSource } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("links manually to a finished bug without changing it, but refuses while original pictures remain", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop);
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Finished bug", backlog: true });
    engine.task(targetId)!.state = "done";
    engine.save();
    const original = structuredClone(engine.task(targetId)!);
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "finished-pictures" };
    const refused = await c.call("task.track-finding", args);
    expect(refused.outcome).toBe("invalid");
    expect(refused.message).toContain("pictures");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    await engine["cleanup"].removeCaptures(source.id);
    expect((await c.call("task.track-finding", { ...args, requestId: "finished-link" })).outcome).toBe("completed");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(engine.task(targetId)).toEqual(original);
    expect(world.prompts).toEqual([]);
  } finally { await shutdown(world.engine); }
});

it("copies manual-link pictures before tracking, keeps concurrent messages, and allows source cleanup", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop, { tracking: { reason: "unavailable", retry: true } });
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Working on it", backlog: true });
    const target = engine.task(targetId)!;
    target.state = "running";
    engine.s.followUpPending = [{ keys: [followUpKey(source.id, "old")], retry: true }];
    const originalCopy = world.files.copyFile;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let copying!: () => void;
    const started = new Promise<void>(resolve => { copying = resolve; });
    const copy = spyOn(world.files, "copyFile").mockImplementation(async (...args) => { copying(); await held; return originalCopy(...args); });
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "pictured-link" };
    try {
      const linking = c.call("task.track-finding", args);
      await started;
      expect(source.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
      target.session.push({ id: "during-copy", from: "agent", text: "Still working", at: 1 });
      await engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
      release();
      expect((await linking).outcome).toBe("completed");
    } finally { release(); copy.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(target.session.some(line => line.id === "during-copy")).toBe(true);
    expect(target.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toHaveLength(1);
    expect(engine.s.followUpPending).toEqual([]);
    expect((await c.call("task.track-finding", { ...args, requestId: "pictures-again" })).outcome).toBe("completed");
    await engine["followUps"].catchUp();
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(target.followUp!.reports).toHaveLength(1);
    expect(target.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    await reopen(world);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(world.prompts).toEqual([]);
  } finally { await shutdown(world.engine); }
});
