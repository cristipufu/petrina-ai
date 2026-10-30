import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses, TAKE_OVER_WORDS } from "@petrina/core";
import { waitFor } from "@petrina/test-support/fixtures";
import { readLooseCommit, readWorktreeCommit } from "../../fixtures/shared-preparation.js";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir, LAUNCHER } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";
const SECRET = "petrina-test-secret-value-1234";

describe.skipIf(!posix)("take over a builder in the terminal, then hand back", () => {
  it("saves its unfinished work, keeps its seat, refuses while the app is open, and the same agent finishes on the same conversation", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      const before = await run.working("builder");
      const session = before.conversation!.sessionId;
      const hold = join(run.root, "hold");
      writeFileSync(hold, "");
      run.cli({ hold, commit: { "committed-by-hand.txt": "Mine\n" }, write: { "by-hand.txt": "Blue\n", "greeting.txt": "Hi\n" } });
      const engine = run.engine();

      const launched = await engine.takeOver(run.taskId);
      expect(launched.terminal).toBe("Test terminal");
      expect(launched.problem).toBeUndefined();
      let task = run.task();
      // The step is paused in the coordinator's hands, and keeps its seat in the pool.
      expect(task.driving).toMatchObject({ roleId: "builder", profileId: "sol-xhigh", toolId: "codex", terminal: "Test terminal" });
      expect(task.state).toBe("needs-you");
      expect(task.holdsSlot).toBe(true);
      expect(task.statusLine).toBe(TAKE_OVER_WORDS.status);
      expect(task.stepClock!.since).toBeUndefined();
      expect(slotUses(engine.getState())).toEqual([{ taskId: run.taskId, toolId: "codex", roleId: "builder", profileId: "sol-xhigh", model: "sol", modelId: "gpt-6.1-sol" }]);
      const item = engine.getState().inbox.find((entry) => entry.taskId === run.taskId)!;
      expect(item).toMatchObject({ kind: "driving", blocking: false, roleId: "builder" });
      // The builder's unfinished work was saved as its own commit before the terminal opened.
      expect(task.driving!.saved?.files).toEqual(["notes.txt"]);
      expect(readLooseCommit(join(run.product, ".git"), task.driving!.saved!.sha)?.body.split(/\r?\n/)[0]).toBe("Add a greeting (unfinished work)");
      const drivingCommit = readWorktreeCommit(task.worktree!)!;
      expect(task.driving!.head).toBe(drivingCommit.commit);
      expect(task.savedVersion).toEqual({ commit: task.driving!.head, tree: drivingCommit.tree });
      expect(task.timeline.some((entry) => entry.text === "Saved the Builder's unfinished work as one commit (1 file)")).toBe(true);

      // Pause and Cancel wait for the hand back; pausing the pool changes nothing.
      expect(() => engine.pause(run.taskId)).toThrow(TAKE_OVER_WORDS.handBackFirst);
      expect(() => engine.cancel(run.taskId)).toThrow(TAKE_OVER_WORDS.handBackFirst);
      engine.setPoolPaused(true);
      expect(run.task().holdsSlot).toBe(true);
      engine.setPoolPaused(false);

      // The app opened in the working copy, on the same conversation and model, in its normal mode.
      await waitFor(() => run.fakes.marked("cli-started"), "the app to open");
      const opened = run.launched()[0]!;
      expect(realpathSync(opened.cwd)).toBe(realpathSync(task.worktree!));
      expect(opened.args).toEqual(["resume", session, "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"]);
      // Petrina's own variables stay out of the terminal; the coordinator's own login is theirs to keep.
      const launcher = readFileSync(join(takeoverDir(run.data, run.taskId), LAUNCHER), "utf8");
      expect(launcher).not.toContain(SECRET);
      expect(statSync(takeoverDir(run.data, run.taskId)).mode & 0o777).toBe(0o700);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "running", "the launcher to report it started");

      // While the app is open: no hand back, no second copy, and messages wait.
      await expectRejection(engine.handBack(run.taskId, "", true), TAKE_OVER_WORDS.stillOpen("Codex"));
      expect((await engine.handBackPreview(run.taskId)).open).toBe("running");
      await expectRejection(engine.reopenTerminal(run.taskId), TAKE_OVER_WORDS.alreadyOpen("Codex"));
      engine.sendMessage(run.taskId, "Keep it short", "interrupt");
      expect(run.task().queued.map((message) => message.text)).toEqual(["Keep it short"]);

      // The coordinator finishes and closes the app.
      rmSync(hold);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      const preview = await engine.handBackPreview(run.taskId);
      expect(preview).toMatchObject({ open: "ended", tool: "Codex", commits: 1, files: 3, unsaved: true, saved: { files: 1, names: ["notes.txt"] } });
      expect(preview.problem).toBeUndefined();

      await engine.handBack(run.taskId, "Fixed the colour by hand");
      task = run.task();
      expect(task.driving).toBeUndefined();
      const handedBackCommit = readWorktreeCommit(task.worktree!)!;
      expect(task.savedVersion).toEqual({ commit: handedBackCommit.commit, tree: handedBackCommit.tree });
      expect(engine.getState().inbox.some((entry) => entry.kind === "driving")).toBe(false);
      expect(existsSync(takeoverDir(run.data, run.taskId))).toBe(false);
      expect(handedBackCommit.body.split(/\r?\n/)[0]).toBe("Add a greeting (changes made by hand)");
      const note = task.notes!.at(-1)!.text;
      // This workflow checks the hand-back evidence, not how fast the machine finishes it.
      // Duration wording is checked separately with explicit elapsed times.
      expect(note).toMatch(/^Handed back after driving the Builder by hand in the terminal \(Codex\) for (?:less than a minute|\d+ minutes?|\d+ hours?)\./);
      expect(note).toContain("- Before the take-over, Petrina saved the Builder's unfinished work as one commit: 1 file (notes.txt).");
      expect(note).toContain("- Commits made while driving: 1.");
      expect(note).toContain("- Files added, changed or removed while driving: 3.");
      expect(note).toContain("  - added: by-hand.txt");
      expect(note).toContain("- Petrina saved what was left unsaved as one commit, marked as made by hand.");
      expect(note).toContain("- Note: Fixed the colour by hand");
      expect(task.session.some((line) => line.from === "you" && line.text === note)).toBe(true);
      expect(task.timeline.some((entry) => entry.text === "You handed back to the Builder: 3 files changed in 2 commits. Your note: Fixed the colour by hand")).toBe(true);
      expect(task.timeline.some((entry) => entry.text === "Tests check on your changes passed: no tests removed or skipped")).toBe(true);
      // Review is still ahead of the build: it covers the changes, nothing extra is added.
      expect(task.handChanges).toBe(true);
      expect(task.rereview).toBeUndefined();

      const done = await run.finished();
      const builder = run.fakes.received("builder");
      const continued = engine.tracking.log.turns({ taskId: run.taskId }).filter(turn => turn.sessionId === session);
      expect(continued).toHaveLength(2);
      expect(new Set(continued.map(turn => turn.agentRunId)).size).toBe(1);

      // The same conversation, which now holds the turn typed in the terminal.
      expect(builder.every((entry) => entry.session === session)).toBe(true);
      expect(run.fakes.opens().filter((open) => open.session === session).map((open) => open.how)).toEqual(["new", "resume"]);
      const heard = builder.at(-1)!.text;
      expect(heard).toStartWith("The coordinator took over this step in their own terminal, on this same conversation, and has handed it back to you.");
      expect(heard).toContain(note);
      expect(heard).toContain("Messages from the coordinator, in order\n1. Keep it short");
      expect(done.session.some((line) => line.from === "agent" && line.text.includes("Terminal turns: 1."))).toBe(true);
      expect(done.timeline.some((entry) => entry.text === "Took the step back on the same conversation")).toBe(true);
      expect(done.timeline.filter((entry) => entry.text === "Reviewing your changes: the review starts again from the first reviewer")).toHaveLength(0);
      expect(done.handChanges).toBeUndefined();
      expect(done.steps!.filter((step) => step.roleId === "builder")).toHaveLength(1);
      // Everything done by hand and by the agent landed.
      for (const file of ["notes.txt", "by-hand.txt", "committed-by-hand.txt"]) expect(readFileSync(join(run.product, file), "utf8").trim()).toBeTruthy();
      expect(readFileSync(join(run.product, "greeting.txt"), "utf8").replace(/\r?\n$/, "")).toBe("Hello");

    } finally { await run.close(); }

  });
});
});
