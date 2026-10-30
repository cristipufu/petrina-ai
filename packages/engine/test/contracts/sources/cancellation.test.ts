import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finish, itemOf, remoteRef, taskOf, until, waitForFile } from "../../support.js";
import { sourceWorlds, pull, deliveryGate } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

describe.concurrent("review findings for a confirmed start",()=>{
it("does not record a refused commit push as delivered when the task is cancelled", async () => {
    await fixtures.world("cancel-unpushed", async ({ w, engine: withEngine, candidate }) => {
    const reject = join(w.remote, "hooks", "pre-receive");
    writeFileSync(reject, "#!/bin/sh\nexit 1\n");
    chmodSync(reject, 0o755);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", description: "[quick]", delivery: "local", approvePlan: false }, { checks: "none" });
      const failed = taskOf(await finish(engine, id), id);
      expect(failed.localUpdate?.pushed).toBe(false);
      expect(failed.landed).toBeUndefined();
      expect(failed.error).toContain("could not push it to GitHub");
      const remote = await remoteRef(w.remote, "refs/heads/main");
      engine.cancel(id);
      const cancelled = taskOf(await until(engine, (s) => taskOf(s, id).state === "cancelled" && taskOf(s, id).shipping === undefined, () => {}), id);
      expect(cancelled.localUpdate?.pushed).toBe(false);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(remote);
      const timeline = cancelled.timeline.map((entry) => entry.text).join("\n");
      expect(timeline).toContain("push to GitHub did not finish");
      expect(timeline).not.toContain("pushed to GitHub");

    });
    });
  });
});

describe.concurrent("review findings for a confirmed start",()=>{
it("keeps an open pull request's link and working copy when commit delivery is cancelled before GitHub has the work", async () => {
    await fixtures.world("cancel-pr-local", async ({ w, engine: withEngine, candidate }) => {
    await pull(w);
    const hold = join(w.dir, "hold-pr");
    const reached = join(w.dir, "pr-push-reached");
    writeFileSync(hold, "");
    const hook = join(w.remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\nif test ! -f '${reached}'; then\n  touch '${reached}'\n  while test -f '${hold}'; do sleep 0.05; done\n  exit 1\nfi\nexit 0\n`);
    chmodSync(hook, 0o755);

    await withEngine(async engine => {

    try {
      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", description: "[quick]", startFrom: { kind: "pull-request", value: "7" }, delivery: "local" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      engine.approve(itemOf(state, id, "delivery")!.id);
      await waitForFile(reached);
      engine.cancel(id);
      rmSync(hold);
      const task = taskOf(await until(engine, (s) => {
        const current = taskOf(s, id);
        return current.state === "cancelled" && current.shipping === undefined && current.pr?.number === 7;
      }, () => {}), id);
      expect(task.pr).toMatchObject({ number: 7, state: "open" });
      expect(task.landed).toBeUndefined();
      expect(task.localUpdate?.pushed).not.toBe(true);
      expect(existsSync(task.worktree!)).toBe(true);
      expect(task.cleanup?.removedAt).toBeUndefined();
      expect(w.github().prs[0]?.state).toBe("OPEN");

    } finally { rmSync(hold, { force: true });  }
    });
    });
  });
});
