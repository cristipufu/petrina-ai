import { expectRejection } from "./rejections.js";
// Take over in the coordinator's terminal, and hand back, end to end on fake agents. The "terminal"
// runs Petrina's real launcher with sh, and the launcher opens a fake of the agent's own app
// (fake-cli.ts) that adds a turn to the conversation and changes the working copy like a person would.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { slotUses, TAKE_OVER_WORDS, type State, type Task } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import * as gitOps from "../src/git.js";
import { sessionState } from "../src/terminal.js";
import type { CliScript } from "./fake-cli.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, newProgramsStart, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
beforeAll(() => newProgramsStart());
afterAll(() => roots.forEach(removeDir));

const posix = process.platform !== "win32";
const SECRET = "petrina-test-secret-value-1234";

/** A product delivering locally with no checks, a task on it, and an engine whose terminal runs the launcher with sh. */
async function start(scenario: Scenario, description = "", open: (launcher: string) => string[] = (launcher) => ["/bin/sh", launcher]) {
  const root = tempDir("petrina-takeover-");
  roots.push(root);
  const product = await makeProduct(root);
  const data = join(root, "data");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  // The agent's own app on "PATH": a wrapper around the fake, as an installed tool would be.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const app = join(bin, "agent-app");
  // Help is static fixture data. Answer in the wrapper so a cold Bun startup cannot
  // consume the installed tool's real help deadline and silently select the fallback mode.
  writeFileSync(app, `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\\n' '--permission-mode <mode> (choices: "manual", "default")'
  exit 0
fi
exec '${process.execPath}' '${join(import.meta.dir, "fake-cli.ts")}' '${fakes.dir}' "$@"
`);
  chmodSync(app, 0o755);
  const options: EngineOptions = {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir],
    toolPath: () => app,
    terminals: () => [{ id: "test", name: "Test terminal", open }],
  };
  let engine = new Engine(data, options);
  const productId = await engine.addProduct(product);
  engine.setProductDelivery(productId, "local", false);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description });
  const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
  const cli = (script: CliScript) => writeFileSync(join(fakes.dir, "cli.json"), JSON.stringify({ ...script, ownerPid: script.ownerPid ?? process.pid }));
  const finished = () => waitFor(() => (task().state === "done" ? task() : task().state === "failed" ? Promise.reject(new Error(task().error)) : undefined), "the task to finish", 90_000);
  /** Wait until the agent of a role is at work in a conversation that has its instructions. */
  const working = (roleId: string) => waitFor(() => task().agent?.roleId === roleId && task().conversation?.briefed && task().conversation?.roleId === roleId && task(), `the ${roleId} to be at work`);
  const restart = async () => {
    await engine.shutdown();
    engine = new Engine(data, options);
    return engine;
  };
  return { root, product, data, fakes, options, taskId, task, cli, finished, working, restart, engine: () => engine, launched: () => cliRuns(fakes) };
}

function cliRuns(fakes: Fakes): { args: string[]; cwd: string; env: string[] }[] {
  const path = join(fakes.dir, "cli.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function unusedPid(): number {
  let pid = process.pid + 1;
  for (;;) {
    try { process.kill(pid, 0); pid += 1; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
      // A live process owned by another user is not an available stand-in for a dead owner.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      pid += 1;
    }
  }
}

const takeoverDir = (data: string, taskId: string) => join(data, "takeover", taskId);
const LAUNCHER = process.platform === "darwin" ? "open.command" : "open.sh";

describe.skipIf(!posix)("take over a builder in the terminal, then hand back", () => {
  it("lets the fake terminal app exit when its test worker is gone", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    try {
      await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
      await run.working("builder");
      const hold = join(run.root, "hold");
      writeFileSync(hold, "");
      run.cli({ hold, ownerPid: unusedPid() });

      const opened = await run.engine().takeOver(run.taskId);
      expect(opened.problem).toBeUndefined();
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the orphaned fake app to close");
      expect(run.fakes.marked("cli-done")).toBe(true);
    } finally {
      await run.engine().shutdown();
    }
  });

  it("saves its unfinished work, keeps its seat, refuses while the app is open, and the same agent finishes on the same conversation", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    await waitFor(() => run.fakes.marked("builder-working"), "the builder to draft");
    const before = await run.working("builder");
    const session = before.conversation!.sessionId;
    const hold = join(run.root, "hold");
    writeFileSync(hold, "");
    run.cli({ hold, commit: { "committed-by-hand.txt": "Mine\n" }, write: { "by-hand.txt": "Blue\n", "greeting.txt": "Hi\n" } });
    process.env.PETRINA_TEST_SECRET = SECRET;
    process.env.GH_TOKEN_FOR_TEST = SECRET;
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
    expect(await git(task.worktree!, "log", "-1", "--format=%s", task.driving!.saved!.sha)).toBe("Add a greeting (unfinished work)");
    expect(task.driving!.head).toBe(await git(task.worktree!, "rev-parse", "HEAD"));
    expect(task.savedVersion).toEqual({ commit: task.driving!.head, tree: await git(task.worktree!, "rev-parse", "HEAD^{tree}") });
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
    expect(opened.env.filter((name) => name.startsWith("PETRINA_"))).toEqual([]);
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
    expect(task.savedVersion).toEqual({ commit: await git(task.worktree!, "rev-parse", "HEAD"), tree: await git(task.worktree!, "rev-parse", "HEAD^{tree}") });
    expect(engine.getState().inbox.some((entry) => entry.kind === "driving")).toBe(false);
    expect(existsSync(takeoverDir(run.data, run.taskId))).toBe(false);
    expect(await git(task.worktree!, "log", "-1", "--format=%s")).toBe("Add a greeting (changes made by hand)");
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
    for (const file of ["notes.txt", "by-hand.txt", "committed-by-hand.txt"]) expect(await git(run.product, "show", `main:${file}`)).toBeTruthy();
    expect(await git(run.product, "show", "main:greeting.txt")).toBe("Hello");
    delete process.env.PETRINA_TEST_SECRET;
    delete process.env.GH_TOKEN_FOR_TEST;
    await run.engine().shutdown();
  });
});

describe.skipIf(!posix)("take over a reviewer, which is read-only", () => {
  it("keeps what was changed by hand, carries on in a fresh conversation when the tool cannot reopen it, and reviews again from the first reviewer without using a round", async () => {
    const run = await start({ planner: "short", builder: "plain", reviewer: "work" });
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
    await run.engine().shutdown();
  });
});

describe.skipIf(!posix)("hand changes after every review chain", () => {
  it("runs the last review chain again once the step is done, before delivery", async () => {
    const run = await start({ planner: "tester-after", builder: "plain", tester: "work" });
    await waitFor(() => run.fakes.marked("tester-working"), "the tester to start");
    await run.working("tester");
    run.cli({ commit: { "fix.txt": "A fix\n" } });
    const engine = run.engine();
    await engine.takeOver(run.taskId);
    await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
    await engine.handBack(run.taskId, "One more fix");
    const review = run.task().plan!.stages.find((stage) => stage.kind === "review-chain")!;
    expect(run.task().rereview).toBe(review.id);

    const done = await run.finished();
    const milestones = done.timeline.map((entry) => entry.text);
    const rerun = milestones.indexOf("Reviewing your changes: the review starts again from the first reviewer");
    expect(rerun).toBeGreaterThan(milestones.indexOf("You handed back to the Tester: 1 file changed in 1 commit. Your note: One more fix"));
    // The review ran again after the tester finished, and only then did the work ship.
    expect(milestones.filter((text) => text === "Code reviewer started")).toHaveLength(2);
    expect(milestones.findLastIndex((text) => text.startsWith("Review passed"))).toBeGreaterThan(rerun);
    expect(milestones.findLastIndex((text) => text.startsWith("Review passed"))).toBeLessThan(milestones.findIndex((text) => text.startsWith("Petrina moved main forward to it")));
    expect(done.rounds[review.id]).toBeUndefined();
    expect(await git(run.product, "show", "main:fix.txt")).toBe("A fix");
    await run.engine().shutdown();
  });
});

describe.skipIf(!posix)("hand changes during design", () => {
  it("clears the question the architect had open, keeps the change, and the plan carries on in order with no extra review pass", async () => {
    const run = await start({ builder: "plain" }, "[no-check]");
    const asked = await waitFor(() => run.engine().getState().inbox.find((item) => item.taskId === run.taskId && item.kind === "question"), "the architect's question");
    expect(asked).toBeTruthy();
    await run.working("architect");
    run.cli({ write: { "design-note.txt": "A sketch\n" } });
    const engine = run.engine();
    await engine.takeOver(run.taskId);
    expect(engine.getState().inbox.filter((item) => item.taskId === run.taskId).map((item) => item.kind)).toEqual(["driving"]);
    expect(run.task().conversation?.asked).toBeUndefined();
    await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
    await engine.handBack(run.taskId);
    expect(run.task().rereview).toBeUndefined();
    expect(run.task().handChanges).toBe(true);

    const done = await run.finished();
    expect(done.timeline.some((entry) => entry.text === "Reviewing your changes: the review starts again from the first reviewer")).toBe(false);
    // Two reviewers in the chain, each once.
    expect(done.timeline.filter((entry) => entry.text === "Code reviewer started")).toHaveLength(2);
    expect(await git(run.product, "show", "main:design-note.txt")).toBe("A sketch");
    await run.engine().shutdown();
  });
});

describe.skipIf(!posix)("take over, copy the command, and restart Petrina", () => {
  it("keeps the observed commit when handing back unchanged work without another HEAD read", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
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
    } finally { read?.mockRestore(); await run.engine().shutdown(); }
  });

  it("keeps the task in the coordinator's hands with its seat, and offers Hand back anyway only when it cannot tell", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
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
    const first = Bun.spawn(["/bin/sh", "-c", launched.command], { stdout: "ignore", stderr: "ignore" });
    await waitFor(async () => run.fakes.marked("cli-started") && (await sessionState(takeoverDir(run.data, run.taskId))) === "running", "the copied command to start");
    const second = Bun.spawn(["/bin/sh", "-c", launched.command], { stdout: "pipe", stderr: "ignore" });
    expect(await second.exited).toBe(1);
    expect(await new Response(second.stdout).text()).toContain("Codex is already open in your terminal for this task. Use that window.");
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
    await engine.shutdown();
  });

  it("refuses to hand back while the working copy is off the task's branch", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
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
    await engine.shutdown();
  });
});

describe.skipIf(!posix)("opening the terminal again", () => {
  it("never overlaps with a hand back or another reopen, and an earlier session's end never lets a hand back through", async () => {
    // The stand-in terminal waits until the assertions finish, instead of racing a two-second delay.
    let opening: string | undefined;
    const run = await start({ planner: "short", builder: "work", reopen: "resume" }, "", (launcher) => opening
      ? ["/bin/sh", "-c", 'while [ -e "$1" ]; do sleep 0.03; done; exec /bin/sh "$2"', "terminal", opening, launcher]
      : ["/bin/sh", launcher]);
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
    await engine.shutdown();
  }, 60_000);
});

describe.skipIf(!posix)("when the agent's work cannot be saved", () => {
  it("lets the agent carry on instead of leaving a stopped step holding its seat", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
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
    await engine.shutdown();
  });
});

describe.concurrent("when take over is not available", () => {
  it("is refused for a task with no agent, with a plain reason", async () => {
    const root = tempDir("petrina-takeover-");
    roots.push(root);
    const product = await makeProduct(root);
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
    const productId = await engine.addProduct(product);
    engine.setPoolPaused(true);
    const taskId = engine.addTask({ productId, title: "Add a greeting" });
    await expectRejection(engine.takeOver(taskId), TAKE_OVER_WORDS.noAgent);
    expect((engine.getState() as State).terminals).toEqual([]);
    expect(() => engine.setTerminal("iterm")).toThrow("That terminal is not on this machine");
    await engine.shutdown();
  });
});

export type { Task };
