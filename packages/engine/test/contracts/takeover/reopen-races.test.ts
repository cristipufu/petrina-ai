import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TAKE_OVER_WORDS } from "@petrina/core";
import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("opening the terminal again", () => {
  it("never overlaps with a hand back or another reopen, and an earlier session's end never lets a hand back through", async () => {
  return fixtures.use(async caseOwner => {
    // The stand-in terminal waits until the assertions finish, instead of racing a two-second delay.
    let opening: string | undefined;
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      await run.working("builder");
      run.cli({});
      const engine = run.engine();
      await engine.takeOver(run.taskId);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      expect(run.launched()).toHaveLength(1);

      // Two quick clicks on Reopen terminal, and Hand back while it opens: only the first goes ahead.
      const hold = join(run.root, "hold");
      opening = join(run.root, "opening");
      run.setOpening(opening);
      writeFileSync(opening, "");
      writeFileSync(hold, "");
      run.cli({ hold, write: { "again.txt": "Again\n" } });
      const first = engine.reopenTerminal(run.taskId);
      await expectRejection(engine.reopenTerminal(run.taskId), TAKE_OVER_WORDS.busy.reopening);
      await expectRejection(engine.handBack(run.taskId), TAKE_OVER_WORDS.busy.reopening);
      await expectRejection(engine.handBack(run.taskId, "", true), TAKE_OVER_WORDS.busy.reopening);
      expect((await first).terminal).toBe("Test terminal");

      // The terminal is open but the app has not reported yet: the last session's end says nothing about this one.
      expect(run.launched()).toHaveLength(1);
      expect((await engine.handBackPreview(run.taskId)).open).toBe("unknown");
      await expectRejection(engine.handBack(run.taskId), TAKE_OVER_WORDS.cannotTell("Codex"));
      rmSync(opening);
      await waitFor(async () => run.launched().length === 2 && (await sessionState(takeoverDir(run.data, run.taskId))) === "running", "the app to open again");

      // Open: no hand back, even anyway, and no third copy.
      await expectRejection(engine.handBack(run.taskId, "", true), TAKE_OVER_WORDS.stillOpen("Codex"));
      await expectRejection(engine.reopenTerminal(run.taskId), TAKE_OVER_WORDS.alreadyOpen("Codex"));
      expect(run.task().driving).toBeTruthy();

      rmSync(hold);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close again");
      await engine.handBack(run.taskId);
      await run.finished();
      expect(run.launched()).toHaveLength(2);
      expect(await git(run.product, "show", "main:again.txt")).toBe("Again");

    } finally { await run.close(); }

  });
}, 60_000);
});
