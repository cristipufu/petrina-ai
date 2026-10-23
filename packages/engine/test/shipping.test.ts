// Shipping is never repeated blindly, even across an ordinary quit or a forced kill: engines run as
// separate processes, the way the desktop app starts them.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyProblems, type DeliveryMode, type State, type Task } from "@petrina/core";
import { Store } from "../src/store.js";
import { EngineProcess, Fakes, git, makeWorld, remoteRef, removeDir, waitFor, type World } from "./support.js";

const worlds: World[] = [];
const holds: string[] = [];
afterAll(() => {
  // A fake gh left holding by a killed engine lets go.
  for (const hold of holds) rmSync(hold, { force: true });
  for (const made of worlds) removeDir(made.dir);
});

/** A product delivering in `mode` without asking, a task on its way there, and an engine running it. `hold`: a gh command that waits after doing its work. */
async function shipping(mode: DeliveryMode, options: { hold?: string; holdMatch?: string; notes?: "hang" } = {}) {
  const w = await makeWorld(`shipping-${mode}`, options.notes ? { version: "1.0.0" } : {});
  worlds.push(w);
  if (options.notes) {
    // An existing version and release make preparation change the version, so its checks rerun on resume.
    await git(w.remote, "update-ref", "refs/tags/v1.0.0", w.initial);
    w.setGitHub((github) => github.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "The previous release." }));
  }
  const home = join(w.dir, "home");
  const fakes = new Fakes(w.dir);
  fakes.scenario({ planner: "short", builder: "plain", ...(options.notes ? { releaseManager: options.notes } : {}) });
  const hold = join(w.dir, "hold");
  if (options.hold) {
    writeFileSync(hold, "");
    holds.push(hold);
    w.setGitHub((github) => (github.hold = { command: options.hold!, file: hold, ...(options.holdMatch ? { match: options.holdMatch } : {}) }));
  }
  const engine = await EngineProcess.harness(home, w.dir, w.remote);
  const productId = (await engine.act("addProduct", w.clone)) as string;
  await engine.act("setProductDelivery", productId, mode, false);
  const taskId = (await engine.act("addTask", { productId, title: "Add a greeting" })) as string;
  const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
  const restart = () => EngineProcess.harness(home, w.dir, w.remote);
  return { w, home, fakes, engine, taskId, find, hold, restart };
}

const delivered = (task: Task | undefined) => task?.state === "done" || task?.state === "pr-open";
const shippingItem = (state: State, taskId: string) => state.inbox.find((item) => item.taskId === taskId && item.kind === "shipping");
const creates = (w: World) => w.github().calls.filter((call) => call[1] === "create");

describe.concurrent("shipping is never repeated blindly", () => {
  for (const mode of ["pull-request", "release"] as const) {
    for (const stop of ["quit", "kill"] as const) {
      it(`${mode}: finds what GitHub published just before ${stop === "quit" ? "an ordinary quit" : "a forced kill"}, and records it`, async () => {
        const run = await shipping(mode, { hold: mode === "pull-request" ? "pr create" : "release create" });
        await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to publish");
        // Saved before the step started.
        expect(run.find(await run.engine.state()).shipping?.step).toBe(mode === "pull-request" ? "open" : "release");
        if (stop === "quit") await run.engine.quit();
        else await run.engine.kill();

        const engine = await run.restart();
        const task = run.find(await engine.until((state) => delivered(run.find(state)), "the delivery to be recorded"));
        expect(task.timeline.some((entry) => entry.text.startsWith("Found after a restart that it had already gone out"))).toBe(true);
        expect(task.shipping).toBeUndefined();
        expect(creates(run.w)).toHaveLength(1);
        expect(journeyProblems(task)).toEqual([]);
        expect(task.journey!.filter((step) => step.roleId === "release-manager")).toHaveLength(mode === "release" ? 1 : 0);
        expect(task.journey!.at(-1)).toMatchObject({ kind: "petrina", work: "delivery", end: "done" });
        // Only a release has an agent at delivery, and it wrote the notes once.
        expect(run.fakes.openings("release manager")).toHaveLength(mode === "release" ? 1 : 0);
        if (mode === "pull-request") {
          expect(task.state).toBe("pr-open");
          expect(task.pr?.number).toBe(1);
          expect(run.w.github().prs).toHaveLength(1);
        } else {
          expect(task.release?.tag).toBe("v0.1.0");
          expect(run.w.github().releases).toHaveLength(1);
        }
        // Every lookup was pinned to the product's repository and ran outside any working copy and Petrina's folder.
        for (const call of run.w.github().calls) expect(call[0] === "repo" ? call[2] : call[call.indexOf("--repo") + 1]).toBe("acme/demo");
        for (const cwd of run.w.github().cwds ?? []) expect(realpathSync(cwd).startsWith(realpathSync(run.w.dir))).toBe(false);
        expect(run.w.github().cwds?.length).toBe(run.w.github().calls.length);
        await engine.quit();
      });
    }
  }

  it("local: finds a move of main that went through but was not saved, after a forced kill", async () => {
    const run = await shipping("local");
    // Simulate a lost delivery save after cleanup completes, rather than interrupting the removal itself.
    const done = run.find(await run.engine.until((state) => delivered(run.find(state)) && run.find(state).cleanup?.removedAt !== undefined, "the local delivery and cleanup"));
    const tested = await git(run.w.clone, "rev-parse", "main");
    await run.engine.kill();
    // As if Petrina was killed right after git moved main, before it saved that.
    const store = new Store(join(run.home, "petrina.db"));
    const state = store.load()!;
    const saved = state.tasks.find((task) => task.id === run.taskId) as unknown as Record<string, unknown>;
    const repository = saved.repository as Record<string, unknown>;
    delete repository.landed;
    delete saved.finishedAt;
    Object.assign(saved, {
      state: "waiting",
      column: "ready",
    });
    repository.shipping = { start: tested, base: run.w.initial, prepared: { tested, summary: "Ready." }, step: "update", boot: "an earlier run", moves: 0, failures: 0 };
    store.save(state);
    store.close();

    const engine = await run.restart();
    const task = run.find(await engine.until((current) => delivered(run.find(current)), "the delivery to be recorded"));
    expect(task.landed?.sha).toBe(done.landed!.sha);
    expect(task.timeline.some((entry) => entry.text === `Found after a restart that it had already gone out: main has the work (${tested.slice(0, 7)})`)).toBe(true);
    expect(await git(run.w.clone, "rev-parse", "main")).toBe(tested);
    // A commit to main needs no agent.
    expect(run.fakes.openings("release manager")).toHaveLength(0);
    await engine.quit();
  });

  it("does not push local main when recovering a task cancelled just after its local move", async () => {
    const run = await shipping("local");
    let engine: Awaited<ReturnType<typeof run.restart>> | undefined;
    try {
      const done = run.find(await run.engine.until((state) => delivered(run.find(state)) && !!run.find(state).cleanup?.removedAt, "the local delivery and cleanup"));
      const tested = await git(run.w.clone, "rev-parse", "main");
      expect(done.landed?.sha).toBe(tested.slice(0, 7));
      await run.engine.kill();

      // Simulate cancellation after local main advanced but before the push step began.
      await git(run.w.remote, "update-ref", "refs/heads/main", run.w.initial);
      const store = new Store(join(run.home, "petrina.db"));
      const state = store.load()!;
      const saved = state.tasks.find((task) => task.id === run.taskId) as unknown as Record<string, unknown>;
      const repository = saved.repository as Record<string, unknown>;
      delete repository.landed;
      delete saved.finishedAt;
      Object.assign(saved, {
        state: "cancelled",
        column: "done",
      });
      repository.shipping = { start: tested, base: run.w.initial, prepared: { tested, summary: "Ready." }, step: "update", boot: "an earlier run", moves: 0, failures: 0 };
      store.save(state);
      store.close();

      engine = await run.restart();
      const task = run.find(await engine.until((current) => run.find(current).shipping === undefined, "cancelled delivery settlement"));
      expect(task.state).toBe("cancelled");
      expect(task.landed?.sha).toBe(tested.slice(0, 7));
      expect(await remoteRef(run.w.remote, "refs/heads/main")).toBe(run.w.initial);
    } finally {
      if (engine) await engine.quit();
    }
  });

  it("carries on publishing when GitHub clearly has nothing, and 'Try again' on a stuck step checks first", async () => {
    const run = await shipping("pull-request");
    run.w.setGitHub((github) => (github.fail = { "pr create": 1 }));
    const stuck = await run.engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "stuck"), "the publishing step to get stuck");
    expect(run.find(stuck).shipping?.step).toBe("open");
    await run.engine.quit();

    const engine = await run.restart();
    await engine.act("retry", (await engine.state()).inbox.find((item) => item.taskId === run.taskId && item.kind === "stuck")!.id);
    const task = run.find(await engine.until((state) => delivered(run.find(state)), "the pull request"));
    expect(task.pr?.number).toBe(1);
    expect(task.timeline.some((entry) => entry.text === "Checked after a restart: No pull request is open for this work yet. Petrina carries on publishing.")).toBe(true);
    expect(run.w.github().prs).toHaveLength(1);
    // A pull request needs no agent at delivery, however often Petrina gets it ready.
    expect(run.fakes.openings("release manager")).toHaveLength(0);
    await engine.quit();
  });

  it("waits for 'Check again' while GitHub cannot be reached, and never takes that for nothing published", async () => {
    const run = await shipping("pull-request", { hold: "pr create" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to open the pull request");
    await run.engine.kill();
    run.w.setGitHub((github) => (github.offline = true));

    const engine = await run.restart();
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    expect(shippingItem(state, run.taskId)!.body).toContain("could not check GitHub");
    await Bun.sleep(300);
    expect(run.w.github().prs).toHaveLength(1);

    // Still unreachable: checking again records Petrina's lookup and another question, with no agent run.
    const waiting = run.find(await engine.state());
    const agents = waiting.journey!.filter((step) => step.kind === "agent");
    await engine.act("checkShipping", shippingItem(state, run.taskId)!.id);
    const askedAgain = await engine.until((current) => !!shippingItem(current, run.taskId), "the new interrupted-shipping item");
    const next = run.find(askedAgain);
    expect(next.journey!.filter((step) => step.kind === "agent")).toEqual(agents);
    expect(next.journey!.at(-1)).toMatchObject({ kind: "you", waitsFor: "shipping" });
    expect(next.journey!.filter((step) => step.kind === "you" && step.waitsFor === "shipping")).toHaveLength(2);
    expect(journeyProblems(next)).toEqual([]);

    run.w.setGitHub((github) => (github.offline = false));
    await engine.act("checkShipping", shippingItem(askedAgain, run.taskId)!.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the delivery to be recorded"));
    expect(done.pr?.number).toBe(1);
    expect(journeyProblems(done)).toEqual([]);
    expect(run.w.github().prs).toHaveLength(1);
    expect(creates(run.w)).toHaveLength(1);
    await engine.quit();
  });

  it("waits while the login cannot see the repository, though GitHub says 'not found', and 'Ship it again' still publishes once", async () => {
    const run = await shipping("release", { hold: "release create" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to create the release");
    await run.engine.kill();
    run.w.setGitHub((github) => (github.hidden = true));

    const engine = await run.restart();
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    expect(shippingItem(state, run.taskId)!.body).toContain("cannot see acme/demo");
    expect(run.w.github().releases).toHaveLength(1);
    expect(creates(run.w)).toHaveLength(1);

    run.w.setGitHub((github) => (github.hidden = false));
    await engine.act("shipAgain", shippingItem(state, run.taskId)!.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the release to be recorded"));
    expect(done.release?.tag).toBe("v0.1.0");
    expect(run.w.github().releases).toHaveLength(1);
    expect(creates(run.w)).toHaveLength(1);
    await engine.quit();
  });

  it("'Ship it again' gets it ready again and still opens only one pull request", async () => {
    const run = await shipping("pull-request", { hold: "pr create" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to open the pull request");
    await run.engine.kill();
    run.w.setGitHub((github) => (github.offline = true));

    const engine = await run.restart();
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    run.w.setGitHub((github) => (github.offline = false));
    await engine.act("shipAgain", shippingItem(state, run.taskId)!.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the pull request to be recorded"));
    expect(done.pr?.number).toBe(1);
    expect(done.timeline.filter((entry) => entry.text.startsWith("Ready to publish"))).toHaveLength(2);
    expect(run.fakes.openings("release manager")).toHaveLength(0);
    expect(run.w.github().prs).toHaveLength(1);
    expect(creates(run.w)).toHaveLength(1);
    await engine.quit();
  });

  it("asks when something else is on GitHub, and 'Mark as done' finishes the task without publishing", async () => {
    const run = await shipping("pull-request", { hold: "pr create" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to open the pull request");
    await run.engine.kill();
    // Someone replaced the task branch with different work: the tested commit is absent.
    const branch = run.w.github().prs[0]!.headRefName;
    const clone = join(run.w.dir, "teammate");
    await git(run.w.dir, "clone", "-q", "--branch", branch, run.w.remote, clone);
    const other = await git(clone, "-c", "user.email=t@example.com", "-c", "user.name=Teammate", "commit-tree", `${run.w.initial}^{tree}`, "-p", run.w.initial, "-m", "Different work");
    await git(run.w.remote, "fetch", "-q", clone, other);
    await git(run.w.remote, "update-ref", `refs/heads/${branch}`, other);

    const engine = await run.restart();
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    expect(shippingItem(state, run.taskId)!.body).toContain("but it is not this work");
    const checked = run.find(state).shipping!.prepared!.tested;
    await engine.act("markDone", shippingItem(state, run.taskId)!.id);
    const done = run.find(await engine.until((current) => run.find(current).cleanup?.foreignPullRequest?.number === 1, "the unrelated open pull request to be checked"));
    expect(done.state).toBe("done");
    expect(done.statusLine).toBe("Marked as done by you");
    expect(done.pr).toBeUndefined();
    expect(done.cleanup?.checkedDelivery?.tested).toBe(checked);
    expect(done.cleanup?.removedAt).toBeUndefined();
    expect(existsSync(done.worktree!)).toBe(true);
    expect(creates(run.w)).toHaveLength(1);
    await engine.quit();
    const reopened = await run.restart();
    const kept = await reopened.task(run.taskId);
    expect(kept.pr).toBeUndefined();
    expect(kept.cleanup?.foreignPullRequest?.number).toBe(1);
    expect(existsSync(kept.worktree!)).toBe(true);
    run.w.setGitHub((github) => { github.prs[0]!.state = "CLOSED"; });
    await reopened.quit();
    const closed = await run.restart();
    const cleaned = run.find(await closed.until((current) => run.find(current).cleanup?.removedAt !== undefined, "the unrelated closed pull request to release its copy"));
    expect(cleaned.pr).toBeUndefined();
    expect(cleaned.cleanup?.foreignPullRequest).toBeUndefined();
    expect(cleaned.statusLine).toBe("Marked as done by you");
    expect(existsSync(cleaned.worktree!)).toBe(false);
    expect(creates(run.w)).toHaveLength(1);
    await closed.quit();
  });

  it("pausing while Petrina works out the version keeps the Release Manager from starting, and resuming ships once", async () => {
    const run = await shipping("release", { hold: "release view", holdMatch: "tagName" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to look up the latest release");
    await run.engine.act("pause", run.taskId);
    rmSync(run.hold, { force: true });
    await Bun.sleep(1500);
    const paused = run.find(await run.engine.state());
    expect(paused.state).toBe("paused");
    expect(run.fakes.openings("release manager")).toHaveLength(0);
    expect(run.w.github().releases).toHaveLength(0);

    await run.engine.act("resume", run.taskId);
    const done = run.find(await run.engine.until((state) => delivered(run.find(state)), "the release"));
    expect(done.release?.tag).toBe("v0.1.0");
    expect(run.fakes.openings("release manager")).toHaveLength(1);
    expect(run.w.github().releases).toHaveLength(1);
    await run.engine.quit();
  });

  for (const stop of ["pause", "restart"] as const) {
    it(`${stop} while writing release notes continues the same Journey box through repeated preparation checks`, async () => {
      const run = await shipping("release", { notes: "hang" });
      let engine: EngineProcess | undefined = run.engine;
      try {
        await waitFor(() => run.fakes.marked("release-manager-started"), "the Release Manager to start writing notes");
        const before = run.find(await engine.state());
        const notes = before.journey!.at(-1)!;
        expect(notes).toMatchObject({ kind: "agent", roleId: "release-manager" });
        expect(notes.endedAt).toBeUndefined();
        const earlierChecks = before.timeline.filter((entry) => entry.text.startsWith("Checks passed:")).length;
        if (stop === "pause") {
          await engine.act("pause", run.taskId);
          const paused = run.find(await engine.until((state) => run.find(state).journey!.at(-1)?.toolActivity?.["release-manager"] !== undefined, "the cancelled Release Manager to record its final activity"));
          expect(paused.state).toBe("paused");
          // Cancellation ends the turn's activity on the same box without finishing the step.
          const { toolActivity, ...pausedBox } = paused.journey!.at(-1)!;
          const { toolActivity: _beforeActivity, ...originalBox } = notes;
          expect(pausedBox).toEqual(originalBox);
          expect(toolActivity).toEqual({ "release-manager": { roleId: "release-manager", profileId: notes.profileId, productId: before.productId, actionCount: 0 } });
          await engine.act("resume", run.taskId);
        } else {
          await engine.quit();
          engine = undefined;
          engine = await run.restart();
        }
        const done = run.find(await engine.until((state) => delivered(run.find(state)), "the release to finish after resuming notes"));
        expect(done.journey!.filter((step) => step.roleId === "release-manager")).toEqual([
          expect.objectContaining({ id: notes.id, startedAt: notes.startedAt, end: "done", outcome: "Wrote the release notes", reason: "release notes ready" }),
        ]);
        // The checks still run on the work and the version commit; their repeated run belongs to the resumed step.
        const repeated = done.timeline.filter((entry) => entry.text.startsWith("Checks passed:")).slice(earlierChecks);
        expect(repeated.length).toBeGreaterThanOrEqual(2);
        expect(repeated.every((entry) => entry.step === notes.id)).toBe(true);
        expect(run.fakes.openings("release manager")).toHaveLength(2);
        expect(done.release?.tag).toBe("v1.0.1");
        expect(creates(run.w)).toHaveLength(1);
        expect(journeyProblems(done)).toEqual([]);
      } finally {
        await engine?.quit();
      }
    });
  }

  it("failed preparation checks interrupt resumed notes without marking them complete", async () => {
    const run = await shipping("release", { notes: "hang" });
    try {
      await waitFor(() => run.fakes.marked("release-manager-started"), "the Release Manager to start writing notes");
      const before = run.find(await run.engine.state());
      const notes = before.journey!.at(-1)!;
      await run.engine.act("pause", run.taskId);
      await run.engine.act("setProductChecks", before.productId, [{ name: "Tests", command: "git no-such-subcommand-petrina" }]);
      await run.engine.act("resume", run.taskId);
      const state = await run.engine.until((state) => run.find(state).journey!.some((step) => step.id === notes.id && step.end === "failed"), "failed preparation checks to interrupt the notes");
      const task = run.find(state);
      expect(task.journey!.filter((step) => step.roleId === "release-manager")).toEqual([
        expect.objectContaining({ id: notes.id, startedAt: notes.startedAt, end: "failed", outcome: "Interrupted", reason: "1 check failed" }),
      ]);
      expect(task.timeline.some((entry) => entry.step === notes.id && entry.text.startsWith("Checks: 1 of 1 failed"))).toBe(true);
      expect(creates(run.w)).toHaveLength(0);
      expect(journeyProblems(task)).toEqual([]);
    } finally {
      await run.engine.quit();
    }
  });

  it("resuming a delivery paused while GitHub published it, even after Petrina is reopened, checks first", async () => {
    const run = await shipping("release", { hold: "release create" });
    await waitFor(() => existsSync(`${run.hold}.reached`), "Petrina to create the release");
    await run.engine.act("pause", run.taskId);
    rmSync(run.hold, { force: true });
    expect(run.find(await run.engine.state()).state).toBe("paused");
    await run.engine.quit();

    const engine = await run.restart();
    expect(run.find(await engine.state()).state).toBe("paused");
    await engine.act("resume", run.taskId);
    const done = run.find(await engine.until((state) => delivered(run.find(state)), "the release to be recorded"));
    expect(done.release?.tag).toBe("v0.1.0");
    expect(run.fakes.openings("release manager")).toHaveLength(1);
    expect(run.w.github().releases).toHaveLength(1);
    expect(creates(run.w)).toHaveLength(1);
    await engine.quit();
  });
});
