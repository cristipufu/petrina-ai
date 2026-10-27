import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cleanup } from "../../../src/cleanup.js";
import { waitFor } from "../../support.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("removes finished and orphaned picture storage without depending on worktree cleanup or loading archive bodies", async () => {
  return cases.use("petrina-report-picture-lifetime-", async owner => {
  const dir = owner.root;
  const data = join(dir, "data");
  const world = { dir, data, start: () => owner.open(data, { terminals: () => [] }) };
  let engine = world.start();
  try {
    engine.setPoolPaused(true);
    await engine.waitUntilReady();
    const productId = "product";
    engine.s.products.push({ id: productId, name: "Product", repo: "acme/demo", tone: "blue" });
    const activeId = engine.addTask({ productId, title: "An unfinished check" });
    const finishedId = engine.addTask({ productId, title: "A finished check" });
    const imageId = "12345678-1234-1234-1234-123456789abc";
    for (const id of [activeId, finishedId]) {
      engine.task(id)!.session.push({ id: `picture-${id}`, at: Date.now(), from: "agent", text: "Page checked", images: [{ id: imageId, caption: "The checked page" }] });
    }
    const finished = engine.task(finishedId)!;
    finished.state = "done";
    finished.column = "done";
    // An open pull request keeps its working copy. It must not keep picture bytes.
    executionFor(finished).work.pr = { number: 1, url: "https://github.com/acme/demo/pull/1", state: "open", openedAt: Date.now() };
    engine.commitNow();
    for (const id of [activeId, finishedId, "deleted-task"]) {
      mkdirSync(join(world.data, "captures", id), { recursive: true });
      writeFileSync(join(world.data, "captures", id, `${imageId}.png`), "picture");
    }
    expect(await engine.reportImage(finishedId, imageId)).toBeUndefined();
    const archived = spyOn(engine.store.history, "get");
    owner.onStop(() => archived.mockRestore());
    try {
      await new Cleanup(engine).sweep();
      expect(archived).not.toHaveBeenCalled();
    } finally { archived.mockRestore(); }
    expect(existsSync(join(world.data, "captures", finishedId))).toBe(false);
    expect(existsSync(join(world.data, "captures", "deleted-task"))).toBe(false);
    expect((await engine.reportImage(activeId, imageId))?.size).toBeGreaterThan(0);
    await owner.stop(engine);
    engine = world.start();
    await engine.waitUntilReady();
    expect((await engine.reportImage(activeId, imageId))?.size).toBeGreaterThan(0);
    engine.cancel(activeId);
    expect(await engine.reportImage(activeId, imageId)).toBeUndefined();
    await waitFor(() => !existsSync(join(world.data, "captures", activeId)), "cancelled pictures to be removed");
    expect(engine.taskDetails(activeId)?.session[0]?.images?.[0]?.caption).toBe("The checked page");
    // Bytes left by an older version are removed by startup, including cancelled history.
    mkdirSync(join(world.data, "captures", activeId), { recursive: true });
    writeFileSync(join(world.data, "captures", activeId, `${imageId}.png`), "leftover");
    await owner.stop(engine);
    engine = world.start();
    await engine.waitUntilReady();
    await waitFor(() => !existsSync(join(world.data, "captures", activeId)), "old terminal pictures to be swept after restart");
  } finally { await owner.stop(engine); }

  });
});
