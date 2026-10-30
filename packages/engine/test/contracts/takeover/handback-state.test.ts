import { afterAll, describe, expect, it, spyOn } from "bun:test";

import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { takeoverFixtures } from "../../fixtures/takeover.js";
import * as gitOps from "@petrina/repositories/git";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("take over, copy the command, and restart Petrina", () => {
  it("keeps the observed commit when handing back unchanged work without another HEAD read", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      let read: ReturnType<typeof spyOn<typeof gitOps, "head">> | undefined;
      try {
        await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
        await run.working("builder");
        const engine = run.engine();
        await engine.takeOver(run.taskId, "copy");
        engine.setPoolPaused(true);
        const before = run.task().driving!.head;
        engine.startDriver = () => {};
        read = spyOn(gitOps, "head");
        await engine.handBack(run.taskId, "No code changes", true);
        expect(read.mock.calls).toEqual([]);
        expect(run.task().driving).toBeUndefined();
        expect(run.task().conversation?.head).toBe(before);
        expect(await git(run.task().worktree!, "rev-parse", "HEAD")).toBe(before);
        expect(run.task().handChanges).not.toBe(true);
      } finally { read?.mockRestore();  }

    } finally { await run.close(); }

  });
});
});
