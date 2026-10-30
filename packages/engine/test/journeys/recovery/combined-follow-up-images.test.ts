import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, cards, combinedAssignments } from "../../fixtures/follow-up-native.js";
const { open, reopen, close, use } = createFollowUpFixtures();
afterAll(close);
it("recovers unfinished reports and pictures on the combined task after the app combines their cards", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  let release = () => {};
  try {
    const saved = await combinedAssignments(world);
    release = saved.release;
    const { sources, originals, combinedId } = saved;
    expect(originals.every(id => !world.engine.s.tasks.some(task => task.id === id))).toBe(true);
    for (const source of sources) expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    await world.engine["followUps"].catchUp();
    await world.engine["followUps"].catchUp();
    for (const source of sources) expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: combinedId });
    const images = world.engine.task(combinedId)!.session.flatMap(line => line.images ?? []);
    expect(images.map(image => image.from?.taskId).sort()).toEqual(sources.map(source => source.id).sort());
    expect(world.engine.s.followUpPending).toEqual([]);
    release();
    for (const source of sources) {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    }
    expect(readdirSync(join(world.data, "captures", combinedId))).toHaveLength(2);
    await reopen(world);
    expect(cards(world.engine).map(task => task.id)).toEqual([combinedId]);
    expect(world.engine.task(combinedId)!.session.flatMap(line => line.images ?? [])).toHaveLength(2);
  } finally { release(); await caseOwner.stop(world.engine); }
  });
});
it("retains combined reports' originals while copying fails and permits manual recovery on a later combined task", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  let release = () => {};
  try {
    const saved = await combinedAssignments(world, true);
    release = saved.release;
    const { sources, combinedId } = saved;
    world.engine.moveToBacklog(combinedId);
    const extra = world.engine.addTask({ productId: world.shop, kind: "bug", title: "Another request", worksOn: world.engine.task(combinedId)!.selectedProducts, backlog: true });
    const latestId = await world.engine.combineBacklog([combinedId, extra], "Combined again", "combine-again");
    const otherId = world.engine.addTask({ productId: world.shop, kind: "bug", title: "Different bug request", backlog: true });
    world.engine.task(otherId)!.state = "running";
    release();
    world.engine.save();
    const original = world.files.copyFile;
    const copy = spyOn(world.files, "copyFile");
    caseOwner.onStop(() => copy.mockRestore());
    copy.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("pic.png")) throw new Error("Copy still refused");
      return original(...args);
    });
    try {
      for (const source of sources) {
        await world.engine["cleanup"].removeCaptures(source.id);
        expect(existsSync(join(world.data, "captures", source.id, "pic.png"))).toBe(true);
      }
      await reopen(world);
      expect(world.engine.s.followUpPending?.every(group => group.cardId === latestId)).toBe(true);
      expect(world.engine.task(latestId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    } finally { copy.mockRestore(); }
    const c = new Coordination(world.engine);
    const checks = world.prompts.length;
    for (const source of sources) {
      const args = { taskId: source.id, findingId: source.findings[0]!.id, targetTaskId: latestId, requestId: `combined-${source.id}` };
      expect((await c.call("task.track-finding", { ...args, targetTaskId: otherId, requestId: `unrelated-${source.id}` })).outcome).toBe("invalid");
      const result = await c.call("task.track-finding", args);
      expect(result.outcome).toBe("completed");
      expect(await c.call("task.track-finding", args)).toEqual(result);
    }
    expect(world.prompts).toHaveLength(checks);
    expect(world.engine.s.followUpPending).toEqual([]);
    for (const source of sources) {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    }
    await reopen(world);
    expect(world.engine.task(latestId)!.followUp!.reports).toHaveLength(2);
    expect(world.engine.task(latestId)!.session.flatMap(line => line.images ?? [])).toHaveLength(3);
    expect(readdirSync(join(world.data, "captures", latestId))).toHaveLength(3);
  } finally { release(); await caseOwner.stop(world.engine); }
  });
});
