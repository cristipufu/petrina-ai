import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";

import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("take over, copy the command, and restart Petrina", () => {
  it("refuses to hand back while the working copy is off the task's branch", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      await run.working("builder");
      run.cli({});
      const engine = run.engine();
      await engine.takeOver(run.taskId);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      const worktree = run.task().worktree!;
      await git(worktree, "checkout", "-q", "-b", "elsewhere");
      expect((await engine.handBackPreview(run.taskId)).problem).toBe("The working copy is no longer on the task's branch. Switch back to it in your terminal, then hand back.");
      await expectRejection(engine.handBack(run.taskId), "no longer on the task's branch");
      expect(run.task().driving).toBeTruthy();
      await git(worktree, "checkout", "-q", run.task().branch!);
      await engine.handBack(run.taskId);
      await run.finished();

    } finally { await run.close(); }

  });
});
});
