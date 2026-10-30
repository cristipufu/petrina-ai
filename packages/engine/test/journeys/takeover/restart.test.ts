import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses, TAKE_OVER_WORDS } from "@petrina/core";
import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir, LAUNCHER } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("take over, copy the command, and restart Petrina", () => {
  it("keeps the task in the coordinator's hands with its seat, and offers Hand back anyway only when it cannot tell", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      await run.working("builder");
      const launched = await run.engine().takeOver(run.taskId, "copy");
      expect(launched.terminal).toBeUndefined();
      expect(launched.command).toBe(`'${join(takeoverDir(run.data, run.taskId), LAUNCHER)}'`);
      expect(run.launched()).toHaveLength(0);

      let engine = await run.restart();
      let task = run.task();
      expect(task.driving).toBeTruthy();
      expect(task.state).toBe("needs-you");
      expect(task.holdsSlot).toBe(true);
      expect(slotUses(engine.getState()).map((use) => use.taskId)).toEqual([run.taskId]);
      expect(engine.getState().inbox.find((item) => item.taskId === run.taskId)?.kind).toBe("driving");
      expect(() => engine.cancel(run.taskId)).toThrow(TAKE_OVER_WORDS.handBackFirst);

      // The command was never run: Petrina cannot tell, so only "anyway" hands back.
      expect((await engine.handBackPreview(run.taskId)).open).toBe("unknown");
      await expectRejection(engine.handBack(run.taskId), TAKE_OVER_WORDS.cannotTell("Codex"));

      // The copied command runs the same launcher; a second copy refuses while the first is open.
      const hold = join(run.root, "hold");
      writeFileSync(hold, "");
      run.cli({ hold, write: { "late.txt": "Late\n" } });
      const first = run.copy(launched.command);
      await waitFor(async () => run.fakes.marked("cli-started") && (await sessionState(takeoverDir(run.data, run.taskId))) === "running", "the copied command to start");
      const second = run.copy(launched.command);
      expect(await second.exited).toBe(1);
      expect(await second.stdout).toContain("Codex is already open in your terminal for this task. Use that window.");
      expect(run.launched()).toHaveLength(1);

      // Restarted again while the app is open: still refused.
      engine = await run.restart();
      await expectRejection(engine.handBack(run.taskId, "", true), TAKE_OVER_WORDS.stillOpen("Codex"));
      rmSync(hold);
      expect(await first.exited).toBe(0);
      await engine.handBack(run.taskId);
      const done = await run.finished();
      expect(await git(run.product, "show", "main:late.txt")).toBe("Late");
      expect(done.timeline.some((entry) => entry.text === "Took the step back on the same conversation")).toBe(true);
      expect(done.steps!.filter((step) => step.roleId === "builder")).toHaveLength(0);

    } finally { await run.close(); }

  });
});
});
