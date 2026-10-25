import { afterAll, describe, expect, it } from "bun:test";

import { waitFor } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("take over a reviewer, which is read-only", () => {
  it("keeps what was changed by hand, carries on in a fresh conversation when the tool cannot reopen it, and reviews again from the first reviewer without using a round", async () => {
    const run = await start({ planner: "short", builder: "plain", reviewer: "work" });
    try {
      await waitFor(() => run.fakes.marked("reviewer-working"), "the reviewer to start");
      const before = await run.working("code-reviewer");
      const review = before.plan!.stages[before.stageIndex]!;
      run.cli({ write: { "hand.txt": "Changed by hand\n" } });
      const engine = run.engine();
      await engine.takeOver(run.taskId);
      // A read-only role has no unfinished work to save.
      expect(run.task().driving!.saved).toBeUndefined();
      await waitFor(() => run.fakes.marked("cli-done"), "the app to finish");
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      // Claude Code's ask-before-acting mode, by the name the installed copy lists.
      expect(run.launched()[0]!.args).toEqual(["--resume", before.conversation!.sessionId, "--model", "opus", "--effort", "high", "--permission-mode", "manual"]);

      await engine.handBack(run.taskId);
      expect(run.task().rereview).toBe(review.id);
      const done = await run.finished();
      // The reviewer carried on in a fresh conversation, told what changed.
      const fresh = run.fakes.openings("code reviewer")[1]!;
      expect(fresh).toContain("## The coordinator drove this step by hand and handed it back");
      expect(fresh).toContain("That conversation could not be reopened (Claude Code cannot reopen conversations), so this one is fresh.");
      expect(fresh).toContain("  - added: hand.txt");
      expect(done.timeline.some((entry) => entry.text === "Carried on in a fresh conversation: Claude Code cannot reopen conversations")).toBe(true);
      expect(done.session.some((line) => line.from === "system" && line.text.startsWith("Code reviewer carried on in a fresh conversation, with your note"))).toBe(true);
      // Then the chain ran again from its first reviewer, without using up its one round.
      expect(done.timeline.filter((entry) => entry.text === "Reviewing your changes: the review starts again from the first reviewer")).toHaveLength(1);
      expect(done.timeline.filter((entry) => entry.text === "Code reviewer started")).toHaveLength(2);
      expect(done.rounds[review.id]).toBeUndefined();
      // The fresh conversation after the hand back is excluded; only the later full review is recorded.
      expect(done.steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      const texts = done.timeline.map((entry) => entry.text);
      expect(texts.lastIndexOf("Tamper check passed: no tests removed or skipped")).toBeGreaterThan(texts.indexOf("Reviewing your changes: the review starts again from the first reviewer"));
      // What was changed by hand is kept, even though the role is read-only, and ships inside the task's one commit.
      expect(await git(run.product, "show", "main:hand.txt")).toBe("Changed by hand");
      expect(await git(run.product, "log", "--format=%s", "main")).toBe("Add a greeting\ninit");

    } finally { await run.close(); }
  });
});
