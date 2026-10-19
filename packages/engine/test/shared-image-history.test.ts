import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cleanup } from "../src/cleanup.js";
import { git, makeWorld, removeDir, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach((world) => removeDir(world.dir)));

for (const archived of [false, true]) for (const first of ["one", "two"] as const) it(`preserves shared report metadata while removing ${first} first (${archived ? "archived" : "live"} task)`, async () => {
  const world = makeWorld(`shared-image-history-${archived}-${first}`);
  worlds.push(world);
  const secondClone = join(world.dir, "second-clone");
  git(world.dir, "clone", "-q", world.clone, secondClone);
  git(secondClone, "remote", "set-url", "origin", "https://github.com/acme/second.git");
  const options = { agentCommand: () => undefined, codexCommand: null, grokCommand: null, terminals: () => [] };
  let engine = world.start(options);
  try {
    await engine.waitUntilReady();
    engine.setPoolPaused(true);
    const one = await engine.addProduct(world.clone);
    const two = await engine.addProduct(secondClone, "Second");
    const taskId = engine.addTask({ productId: one, title: "Check both products" });
    const shared = engine.task(taskId)!;
    const image = { id: "00000000-0000-4000-8000-000000000001", caption: "The shared page" };
    shared.repositories = [one, two].map((productId) => ({ productId, delivery: "local", completedStages: [], landed: { branch: "main", sha: productId } }));
    shared.session = [{ id: "pictured-report", from: "agent", at: 1, text: "Both products checked", productId: two, images: [image] }];
    shared.state = "done";
    shared.column = "done";
    shared.finishedAt = Date.now();
    const captures = join(world.data, "captures", taskId);
    mkdirSync(captures, { recursive: true });
    writeFileSync(join(captures, `${image.id}.png`), "shared picture");
    if (archived) {
      engine.save();
      await engine.shutdown();
      engine = world.start(options);
      await engine.waitUntilReady();
      expect(engine.activeState().tasks).toEqual([]);
    }

    expect(await engine.reportImage(taskId, image.id)).toBeUndefined();
    await new Cleanup(engine).sweep();
    expect(existsSync(captures)).toBe(false);
    engine.taskDetails(taskId); // Clear/prime any cached archive view before membership changes.
    const firstProduct = first === "one" ? one : two;
    engine.removeProduct(firstProduct);
    const remaining = firstProduct === one ? two : one;
    const retained = engine.taskDetails(taskId);
    expect(retained?.session).toEqual(shared.session);
    expect(engine.historyPage({ productId: remaining }).items.map((item) => item.id)).toContain(taskId);
    expect(await engine.reportImage(taskId, image.id)).toBeUndefined();
    engine.save();
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(engine.taskDetails(taskId)?.session).toEqual(shared.session);
    expect(engine.historyPage({ productId: remaining }).items.map((item) => item.id)).toContain(taskId);
    expect(await engine.reportImage(taskId, image.id)).toBeUndefined();

    engine.removeProduct(remaining);
    expect(engine.taskDetails(taskId)).toBeUndefined();
    expect(engine.historyPage({ productId: remaining }).items.map((item) => item.id)).not.toContain(taskId);
    expect(existsSync(captures)).toBe(false);
  } finally { await engine.shutdown(); }
});
