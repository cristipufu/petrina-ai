import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("when the agent's work cannot be saved", () => {
  it("lets the agent carry on instead of leaving a stopped step holding its seat", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      const worktree = (await run.working("builder")).worktree!;
      // Something else holds the working copy's index, so Petrina can't save the builder's draft.
      const lock = resolve(worktree, await git(worktree, "rev-parse", "--git-path", "index.lock"));
      writeFileSync(lock, "");
      const engine = run.engine();
      await expectRejection(engine.takeOver(run.taskId), "Petrina couldn't save the Builder's work before you took over, so the Builder carries on.");
      rmSync(lock);
      const task = run.task();
      expect(task.driving).toBeUndefined();
      expect(task.statusLine).not.toBe("Stopping the agent so you can take over");
      expect(engine.getState().inbox.some((item) => item.taskId === run.taskId && item.kind === "driving")).toBe(false);
      expect(run.launched()).toHaveLength(0);
      expect(existsSync(takeoverDir(run.data, run.taskId))).toBe(false);
      // The builder picks its step back up and finishes, with its draft.
      const done = await run.finished();
      expect(done.timeline.some((entry) => entry.text.startsWith("Could not get the working copy ready for you, so the Builder carries on"))).toBe(true);
      expect(await git(run.product, "show", "main:notes.txt")).toBe("A first draft");

    } finally { await run.close(); }

  });
});
});
