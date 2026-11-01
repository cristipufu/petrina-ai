import { shutdownActors } from "../../fixtures/shutdown-actors.js";
import { installPreparedProduct, acmeDemoProduct } from "../../fixtures/prepared-product.js";
import { afterAll, describe, expect, it } from "bun:test";
import { completeAll } from "@petrina/core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";



import { coordinator, taskOf, until, waitFor, waitForFile } from "../../support.js";
import { cleanupFixture, texts, cleaned, gone } from "../../fixtures/cleanup-world.js";
const { world, close } = cleanupFixture();
afterAll(close);

describe.concurrent("Finished tasks free their working copies", () => {
it("cancels a running builder, waits for its background build, and removes any folder that comes back quietly", async () => {
    let independent: Awaited<ReturnType<typeof shutdownActors>> | undefined;
    let releaseHold = () => {};
    await world("cancel", async w => {
      const actors = await shutdownActors(w.dir); independent = actors;
      if (w.signal.aborted) { await actors.close(); throw new Error("Cleanup actor ownership closed during setup"); }
      const hold = join(w.dir, "builder-hold");
      const pids = join(w.dir, "build-pids");
      releaseHold = () => rmSync(hold, { force: true });
      writeFileSync(hold, "");
      w.setScript((script) => { script.hold = { title: "Long build", file: hold }; script.background = { title: "Long build", pids, program: actors.background }; });
      await w.engine(async engine => {
        try {
          await engine.waitUntilReady(); w.signal.throwIfAborted(); engine.stopRequested.signal.throwIfAborted();
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = engine.addTask({ productId, title: "Long build", description: "[quick]", delivery: "local" });
          await until(engine, () => existsSync(`${hold}.reached`), coordinator());
          const before = taskOf(engine.getState(), id);
          await waitForFile(join(before.worktree!, "target", "background", "out.bin"));
          const pid = Number(readFileSync(pids, "utf8").trim());
          engine.cancel(id);
          const task = await cleaned(engine, id);
          expect(task.state).toBe("cancelled");
          expect(actors.isPidAlive(pid)).toBe(false);
          await gone(w, task);
          expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
          const count = texts(task).length;
          mkdirSync(join(task.worktree!, "target"), { recursive: true });
          writeFileSync(join(task.worktree!, "target", "late.bin"), "late output");
          await waitFor(() => !existsSync(task.worktree!), "late output to go");
          expect(texts(taskOf(engine.getState(), id))).toHaveLength(count);
        } finally { rmSync(hold, { force: true }); await engine.shutdown(); await actors.close(); }
      }, { checkEveryMs: 100 });
    }, { stopPeers: () => completeAll([Promise.resolve().then(releaseHold), Promise.resolve().then(() => independent?.close())]).then(() => undefined) });
  });
});
