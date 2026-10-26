




import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { join } from "node:path";
import { CLEANUP_WORDS } from "@petrina/core";

import { ensureWorktree } from "@petrina/repositories/git";
import { finish, git, remoteRef, taskOf } from "../../support.js";
import { cleanupFixture, texts, cleaned, gone } from "../../fixtures/cleanup-world.js";
const { world, close } = cleanupFixture();
afterAll(close);

describe.concurrent("Finished tasks free their working copies", () => {
it("saves local delivery and all history before removing packages and build output; reading after restart creates nothing", async () => {
    await world("local", async w => {
      const { id, task, turns, moments, usage } = await w.engine(async engine => {
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, "local", true);
        const other = join(w.data, "worktrees", productId, "other");
        await ensureWorktree(w.clone, other, "petrina/other", "main");
        const id = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
        expect(taskOf(await finish(engine, id), id).state).toBe("done");
        const task = await cleaned(engine, id);
        await gone(w, task);
        expect(existsSync(other)).toBe(true);
        expect(readFileSync(join(w.clone, "greeting.txt"), "utf8")).toContain("Hello");
        expect(await git(w.clone, "rev-parse", "main")).toBe(await git(w.clone, "rev-parse", task.branch!));
        expect(await remoteRef(w.remote, "refs/heads/main")).toBe(await git(w.clone, "rev-parse", task.branch!));
        expect(texts(task).findIndex((line) => line.startsWith("Petrina pushed main to GitHub"))).toBeLessThan(texts(task).indexOf(CLEANUP_WORDS.removed));
        expect(task.brief).toBeDefined();
        expect(task.findings.length).toBeGreaterThan(0);
        expect(task.session.length).toBeGreaterThan(0);
        expect(texts(task).at(-1)).toBe(CLEANUP_WORDS.removed);
        const turns = engine.tracking.log.turns({ taskId: id });
        const moments = engine.tracking.log.moments({ taskId: id });
        const usage = engine.usage({ view: "task", taskId: id });
        expect(turns.length).toBeGreaterThan(0);
        expect(moments.filter((entry) => entry.kind === "task-end").map((entry) => entry.outcome)).toEqual(["delivered"]);
        expect(usage.stages.length).toBeGreaterThan(0);
        await engine.shutdown();
        return { id, task, turns, moments, usage };
      });
      await w.engine(async engine => {
        try {
          const saved = taskOf(engine.getState(), id);
          expect(engine.tracking.log.turns({ taskId: id })).toEqual(turns);
          expect(engine.tracking.log.moments({ taskId: id })).toEqual(moments);
          expect(engine.usage({ view: "task", taskId: id })).toEqual(usage);
          for (const key of ["timeline", "session", "brief", "findings", "landed", "report", "cleanup"] as const) expect(saved[key]).toEqual(task[key]);
          await Bun.sleep(150);
          expect(taskOf(engine.getState(), id).agent).toBeUndefined();
          await gone(w, saved);
        } finally { await engine.shutdown(); }
      });
    });
  });
});
