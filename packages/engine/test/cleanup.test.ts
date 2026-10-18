// Real worktrees and fake agents/GitHub: no network, no windows, and branches/history survive removal.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLEANUP_WORDS, type Task } from "@petrina/core";
import type { Engine } from "../src/engine.js";
import { addCopy, branchName, ensureWorktree, removeWorktree } from "../src/git.js";
import { coordinator, finish, git, itemOf, makeWorld, removeDir, remoteRef, taskOf, until, waitFor, waitForFile, type World } from "./support.js";

const worlds: World[] = [];
function world(name: string): World {
  const w = makeWorld(`cleanup-${name}`);
  worlds.push(w);
  // The fake builder leaves the same ignored packages/build output as real tools do.
  writeFileSync(join(w.clone, ".git", "info", "exclude"), "node_modules/\ntarget/\n");
  const cache = join(w.dir, "shared-cache");
  mkdirSync(cache);
  writeFileSync(join(cache, "keep"), "shared");
  w.setScript((script) => (script.installs = { cache }));
  return w;
}
afterAll(() => { for (const w of worlds) removeDir(w.dir); });

const texts = (task: Task) => task.timeline.map((entry) => entry.text);
const cleaned = async (engine: Engine, id: string) => taskOf(await until(engine, (s) => taskOf(s, id).cleanup?.removedAt !== undefined), id);
const listed = (w: World, path: string) => {
  // Git lists native names; the fixture may use a Windows short name or another parent alias.
  // The copy itself may already be gone, so resolve the parent without following a replacement link.
  const nativeParent = (path: string): string => {
    try { return realpathSync.native(path); }
    catch { return join(nativeParent(dirname(path)), basename(path)); }
  };
  const location = (path: string) => join(nativeParent(dirname(path)), basename(path));
  return git(w.clone, "worktree", "list", "--porcelain", "-z").split("\0").filter((field) => field.startsWith("worktree ")).some((field) => location(field.slice("worktree ".length)) === location(path));
};
function gone(w: World, task: Task): void {
  expect(existsSync(task.worktree!), `${task.id}: ${task.worktree} ${JSON.stringify(task.cleanup)}`).toBe(false);
  expect(listed(w, task.worktree!)).toBe(false);
  expect(git(w.clone, "rev-parse", task.branch!)).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(w.dir, "shared-cache", "keep"), "utf8")).toBe("shared");
}

describe.concurrent("Finished tasks free their working copies", () => {
  it("keeps existing pull-request updates out of the new-pull-request attribution check", async () => {
    const w = world("existing-pr-attribution");
    const engine = w.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Update existing pull request", delivery: "pull-request" });
      const task = engine.task(id)!;
      const product = engine.activeState().products.find((entry) => entry.id === productId)!;
      task.source = {
        product: { id: product.id, name: product.name, repo: product.repo, path: product.path },
        start: { kind: "pull-request", number: 77, url: "https://github.com/acme/demo/pull/77", headRepo: product.repo, branch: "existing-feature" },
        destination: { mode: "pull-request", kind: "update-pr", repo: product.repo, branch: "existing-feature" }, confirmed: true,
      };
      task.shipping = { moves: 0, failures: 0, prepared: { tested: w.initial, summary: "Update existing work" } };
      task.cleanup = { checkedDelivery: { tested: w.initial, base: "stale-base" } };
      const item = engine.raise(task, "shipping", "Interrupted update", false);
      engine.markDone(item);
      expect(task.state).toBe("done");
      expect(task.cleanup.checkedDelivery).toBeUndefined();
      expect(task.cleanup.foreignPullRequest).toBeUndefined();
      expect(task.cleanup.pullRequest).toBe("unconfirmed");
      expect(task.shipping).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it("recovers orphaned reviewer copies after the main copy was already removed, leaving unfinished tasks alone", async () => {
    const w = world("reviewer-crash");
    let engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Finished before cleanup", description: "[quick]", delivery: "local", approveDelivery: false });
      await finish(engine, id);
      const task = structuredClone(await cleaned(engine, id));
      await engine.shutdown();
      const folder = join(w.data, "worktrees", productId, `${id}.copies`);
      const copy = join(folder, "review-0");
      const missing = join(folder, "review-1");
      await addCopy(w.clone, copy, git(w.clone, "rev-parse", task.branch!));
      await addCopy(w.clone, missing, git(w.clone, "rev-parse", task.branch!));
      git(w.clone, "worktree", "lock", copy);
      git(w.clone, "worktree", "lock", missing);
      rmSync(missing, { recursive: true, force: true });
      const active = join(w.data, "worktrees", productId, "unfinished.copies", "review-0");
      await addCopy(w.clone, active, git(w.clone, "rev-parse", task.branch!));
      writeFileSync(join(active, "unsaved.txt"), "Keep this unfinished review");
      w.editSaved((state) => {
        const tasks = state.tasks as unknown as Task[];
        tasks.push({ ...task, id: "unfinished", state: "paused", worktree: join(w.data, "worktrees", productId, "unfinished"), cleanup: undefined });
        const previous = state.tasks.find((entry) => entry.id === id)!;
        delete (previous.cleanup as { reviewCopiesRemovedAt?: number }).reviewCopiesRemovedAt;
      });
      engine = w.start({ checkEveryMs: 100 });
      await waitFor(() => !existsSync(folder) && !listed(w, copy) && !listed(w, missing), "orphaned reviewer folders and locked Git records to be removed", 5_000);
      gone(w, taskOf(engine.getState(), id));
      expect(existsSync(active)).toBe(true);
      expect(listed(w, active)).toBe(true);
      expect(readFileSync(join(active, "unsaved.txt"), "utf8")).toBe("Keep this unfinished review");
    } finally { await engine.shutdown(); }
  });

  for (const slots of [1, 2]) it(`does not allocate any of ${slots} free slots to a resumed task still stopping`, async () => {
    const w = world(`stopping-slots-${slots}`);
    const engine = w.start();
    let release!: () => void;
    let stopped = "";
    try {
      engine.setPoolPaused(true);
      engine.setPoolLimit(slots);
      const productId = await engine.addProduct(w.clone);
      stopped = engine.addTask({ productId, title: "Still stopping", delivery: "local" });
      engine.task(stopped)!.state = "paused";
      // A previous driver still finishing its file handling, after Pause and before Resume.
      engine.settling.set(stopped, new Promise<void>((resolve) => { release = resolve; }));
      engine.resume(stopped);
      const queued = Array.from({ length: slots }, (_, index) => engine.addTask({ productId, title: `Use free slot ${index}`, delivery: "local", description: "[quick]", approvePlan: true }));
      engine.setPoolPaused(false);
      expect(taskOf(engine.getState(), stopped).state).toBe("waiting");
      expect(queued.map((id) => taskOf(engine.getState(), id).holdsSlot)).toEqual(Array(slots).fill(true));
      expect(queued.map((id) => taskOf(engine.getState(), id).state)).toEqual(Array(slots).fill("running"));
    } finally {
      release?.();
      engine.settling.delete(stopped);
      await engine.shutdown();
    }
  });

  for (const kind of ["uncertain", "older interrupted", "already marked", "no pull request"] as const) it(`checks GitHub before cleaning a ${kind} delivery marked done, including after restart`, async () => {
    const w = world(`mark-done-${kind.replaceAll(" ", "-")}`);
    w.setGitHub((github) => (github.fail = { "pr create": 1 }));
    let engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Uncertain delivery", description: "[quick]", approveDelivery: false });
      const failed = taskOf(await finish(engine, id), id);
      expect(failed.state).toBe("failed");
      const copy = failed.worktree!;
      w.setGitHub((github) => {
        github.offline = true;
        if (kind !== "no pull request") github.prs.push({ number: 77, url: "https://github.com/acme/demo/pull/77", state: "OPEN", headRefName: failed.branch!, baseRefName: "main", headRefOid: git(w.clone, "rev-parse", failed.branch!), isCrossRepository: false, title: "Uncertain delivery", body: "" });
      });
      await engine.shutdown();
      w.editSaved((state) => {
        const task = state.tasks.find((task) => task.id === id) as unknown as Record<string, unknown>;
        Object.assign(task, { state: kind === "already marked" ? "done" : "waiting", statusLine: "Marked as done by you" });
        if (kind === "older interrupted") task.shipping = { startedAt: Date.now(), attempts: 1 };
        if (kind === "already marked") delete task.shipping;
        (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== id);
      });
      engine = w.start({ checkEveryMs: 100 });
      if (kind !== "already marked") {
        await until(engine, (s) => !!itemOf(s, id, "shipping"), () => {});
        engine.markDone(itemOf(engine.getState(), id, "shipping")!.id);
      }
      const held = taskOf(await until(engine, (s) => {
        const cleanup = taskOf(s, id).cleanup;
        return cleanup?.error !== undefined || cleanup?.removedAt !== undefined;
      }, () => {}), id);
      expect(held.cleanup?.error).toBe(CLEANUP_WORDS.unconfirmedPr);
      expect(taskOf(engine.getState(), id).state).toBe("done");
      expect(existsSync(copy)).toBe(true);
      expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
      await engine.shutdown();
      engine = w.start({ checkEveryMs: 100 });
      expect(existsSync(copy)).toBe(true);
      w.setGitHub((github) => (github.offline = false));
      if (kind === "no pull request") {
        const done = await cleaned(engine, id);
        gone(w, done);
        expect(done.cleanup?.pullRequest).toBe("none");
        expect(done.state).toBe("done");
        return;
      }
      await until(engine, (s) => taskOf(s, id).pr?.state === "open", () => {});
      expect(taskOf(engine.getState(), id).state).toBe("done");
      expect(existsSync(copy)).toBe(true);
      expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
      w.setGitHub((github) => (github.prs[0]!.state = kind === "older interrupted" ? "MERGED" : "CLOSED"));
      const done = await cleaned(engine, id);
      gone(w, done);
      expect(done.state).toBe("done");
      expect(texts(done)).toContain(kind === "older interrupted" ? "Merged #77 on GitHub" : "Closed #77 without merging");
    } finally { await engine.shutdown(); }
  });

  for (const { github, marked } of [{ github: false, marked: false }, { github: false, marked: true }, { github: true, marked: false }]) it(`handles an older local delivery ${marked ? "already marked done" : "marked done now"} for a ${github ? "GitHub" : "computer-only"} product`, async () => {
    const w = world(`older-local-${github}-${marked}`);
    if (!github) git(w.clone, "remote", "remove", "origin");
    w.setGitHub((state) => (state.offline = true));
    let engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Older local delivery", description: "[quick]", delivery: "local", approveDelivery: true });
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
      const copy = taskOf(engine.getState(), id).worktree!;
      expect(existsSync(join(copy, "node_modules", "left-pad"))).toBe(true);
      expect(existsSync(join(copy, "target", "debug"))).toBe(true);
      await engine.shutdown();
      w.editSaved((state) => {
        const task = state.tasks.find((entry) => entry.id === id)!;
        Object.assign(task, marked
          ? { state: "done", shipping: undefined, cleanup: { pullRequest: "unconfirmed", error: CLEANUP_WORDS.unconfirmedPr } }
          : { state: "waiting", shipping: { startedAt: Date.now(), attempts: 1 } });
        (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== id);
      });
      engine = w.start({ checkEveryMs: 100 });
      if (!marked) {
        await until(engine, (state) => !!itemOf(state, id, "shipping"), () => {});
        engine.markDone(itemOf(engine.getState(), id, "shipping")!.id);
      }
      if (github) {
        const task = taskOf(await until(engine, (state) => taskOf(state, id).cleanup?.error !== undefined, () => {}), id);
        expect(task.state).toBe("done");
        expect(task.cleanup?.error).toBe(CLEANUP_WORDS.unconfirmedPr);
        expect(task.cleanup?.removedAt).toBeUndefined();
        expect(existsSync(copy)).toBe(true);
      } else {
        const task = await cleaned(engine, id);
        expect(task.state).toBe("done");
        expect(task.cleanup?.pullRequest).toBe("none");
        expect(task.cleanup?.error).toBeUndefined();
        expect(w.github().calls).toEqual([]);
        gone(w, task);
        await engine.shutdown();
        engine = w.start({ checkEveryMs: 100 });
        expect(taskOf(engine.getState(), id).cleanup).toEqual(task.cleanup);
        expect(w.github().calls).toEqual([]);
        gone(w, taskOf(engine.getState(), id));
      }
    } finally { await engine.shutdown(); }
  });

  for (const resumeImmediately of [false, true]) it(`keeps a copy paused during setup${resumeImmediately ? " and resumed before setup finishes" : " until it is resumed"}`, async () => {
    const w = world(resumeImmediately ? "setup-resumed" : "setup-paused");
    const hold = join(w.dir, "checkout-hold");
    const filter = join(w.dir, "smudge.mjs");
    writeFileSync(hold, "");
    writeFileSync(filter, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const input = readFileSync(0); const hold = ${JSON.stringify(hold)};
      writeFileSync(hold + ".reached", ""); while (existsSync(hold)) Bun.sleepSync(10);
      process.stdout.write(input);`);
    // Hold the actual checkout in git, after it starts creating the copy and before ensureWorktree returns.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    git(w.clone, "config", "filter.petrinaSetup.clean", `${quote(process.execPath)} -e ${quote('process.stdout.write(require("node:fs").readFileSync(0))')}`);
    git(w.clone, "config", "filter.petrinaSetup.smudge", `${quote(process.execPath)} ${quote(filter)}`);
    git(w.clone, "config", "filter.petrinaSetup.required", "true");
    writeFileSync(join(w.clone, ".gitattributes"), "README.md filter=petrinaSetup\n");
    git(w.clone, "add", ".gitattributes");
    git(w.clone, "commit", "-qm", "Hold checkout for the test");
    const engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Pause during setup", description: "[quick]", delivery: "local", approvePlan: true });
      // The plan check stays editable, so the copy is not created until the plan is approved.
      const planned = await until(engine, (s) => !!itemOf(s, id, "plan"), () => {});
      expect(taskOf(planned, id).worktree).toBeUndefined();
      expect(existsSync(`${hold}.reached`)).toBe(false);
      engine.approve(itemOf(planned, id, "plan")!.id);
      await waitForFile(`${hold}.reached`);
      const settling = engine.settling.get(id)!;
      expect(taskOf(engine.getState(), id).worktree).toBeUndefined();
      engine.pause(id);
      if (resumeImmediately) {
        engine.resume(id);
        expect(engine.settling.get(id)).toBe(settling);
      }
      rmSync(hold);
      await settling;
      const path = join(w.data, "worktrees", productId, id);
      expect(existsSync(join(path, "README.md"))).toBe(true);
      expect(listed(w, path)).toBe(true);
      if (!resumeImmediately) {
        expect(taskOf(engine.getState(), id).state).toBe("paused");
        expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
        engine.resume(id);
      }
      await until(engine, (s) => taskOf(s, id).worktree === path && taskOf(s, id).state !== "paused", () => {});
      expect(existsSync(join(path, "README.md"))).toBe(true);
      expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
      expect(texts(taskOf(engine.getState(), id))).not.toContain(CLEANUP_WORDS.removed);
    } finally {
      rmSync(hold, { force: true });
      engine.shutdown();
      await Promise.allSettled([...engine.settling.values()]);
    }
  });

  it.skipIf(process.platform === "win32")("finds a cancelled setup's copy after quitting and retries its locked output after restart", async () => {
    const w = world("setup-cancel-quit");
    const hold = join(w.dir, "checkout-hold");
    const filter = join(w.dir, "smudge.mjs");
    writeFileSync(hold, "");
    writeFileSync(filter, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const input = readFileSync(0); const hold = ${JSON.stringify(hold)};
      writeFileSync(hold + ".reached", ""); while (existsSync(hold)) Bun.sleepSync(10);
      process.stdout.write(input);`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    git(w.clone, "config", "filter.petrinaSetup.clean", `${quote(process.execPath)} -e ${quote('process.stdout.write(require("node:fs").readFileSync(0))')}`);
    git(w.clone, "config", "filter.petrinaSetup.smudge", `${quote(process.execPath)} ${quote(filter)}`);
    git(w.clone, "config", "filter.petrinaSetup.required", "true");
    writeFileSync(join(w.clone, ".gitattributes"), "README.md filter=petrinaSetup\n");
    git(w.clone, "add", ".gitattributes");
    git(w.clone, "commit", "-qm", "Hold checkout for the test");
    let engine = w.start({ checkEveryMs: 100 });
    let locked: string | undefined;
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Cancel during checkout", delivery: "local" });
      await waitForFile(`${hold}.reached`);
      const copy = join(w.data, "worktrees", productId, id);
      locked = join(copy, "target", "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "output"), "build output");
      chmodSync(locked, 0o555);
      engine.cancel(id);
      // Shutdown saves and closes the store while checkout still holds the copy.
      const quitting = engine.shutdown();
      rmSync(hold);
      await quitting;
      expect(existsSync(copy)).toBe(true);
      engine = w.start({ checkEveryMs: 100 });
      // It never became usable before the save. Cleanup recovers only this task's standard folder.
      expect(taskOf(engine.getState(), id).worktree).toBeUndefined();
      await until(engine, (state) => !!taskOf(state, id).cleanup?.error, () => {});
      expect(taskOf(engine.getState(), id).state).toBe("cancelled");
      expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
      chmodSync(locked, 0o755);
      const task = await cleaned(engine, id);
      gone(w, { ...task, worktree: copy, branch: branchName("Cancel during checkout", id) });
      expect(task.state).toBe("cancelled");
      expect(texts(task).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    } finally {
      rmSync(hold, { force: true });
      if (locked && existsSync(locked)) chmodSync(locked, 0o755);
      await engine.shutdown();
    }
  });

  for (const source of ["open", "no-pull-request"] as const) it(`checks a cancelled uncertain delivery marked done with ${source}, including retries and restart`, async () => {
    const w = world(`cancelled-${source}`);
    let engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Older cancelled delivery", description: "[quick]", approveDelivery: false });
      expect(taskOf(await finish(engine, id), id).state).toBe("pr-open");
      const copy = taskOf(engine.getState(), id).worktree!;
      await engine.shutdown();
      w.editSaved((state) => {
        Object.assign(state.tasks.find((task) => task.id === id)!, {
          state: "cancelled", column: "done", statusLine: "Cancelled", pr: undefined,
          shipping: undefined, cleanup: { pullRequest: "unconfirmed" },
        });
      });
      w.setGitHub((github) => { github.offline = true; if (source === "no-pull-request") github.prs = []; });
      engine = w.start({ checkEveryMs: 100 });
      await until(engine, (state) => taskOf(state, id).cleanup?.error === CLEANUP_WORDS.unconfirmedPr, () => {});
      expect(existsSync(copy)).toBe(true);
      expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
      const before = taskOf(engine.getState(), id).timeline;
      const lookups = () => w.github().calls.filter((call) => call[0] === "pr" && call[1] === "list").length;
      const count = lookups();
      await until(engine, () => lookups() >= count + 2, () => {});
      expect(taskOf(engine.getState(), id).timeline).toEqual(before);
      await engine.shutdown();
      engine = w.start({ checkEveryMs: 100 });
      expect(existsSync(copy)).toBe(true);
      w.setGitHub((github) => (github.offline = false));
      if (source !== "no-pull-request") {
        await until(engine, (state) => taskOf(state, id).pr?.state === "open", () => {});
        expect(existsSync(copy)).toBe(true);
        expect(taskOf(engine.getState(), id).state).toBe("cancelled");
        expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
        w.setGitHub((github) => (github.prs[0]!.state = "CLOSED"));
      }
      const task = await cleaned(engine, id);
      gone(w, task);
      expect(task.state).toBe("cancelled");
      expect(task.statusLine).toBe("Cancelled");
      expect(task.cleanup?.pullRequest).toBe("none");
      expect(texts(task).filter((text) => text === CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr))).toHaveLength(1);
      if (source !== "no-pull-request") expect(texts(task)).toContain("Closed #1 without merging");
      expect(w.github().calls.every((call) => !call.includes("merge") && !call.includes("close"))).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it("cleans a cancelled computer-only delivery marked done without asking GitHub", async () => {
    const w = world("cancelled-computer-only");
    git(w.clone, "remote", "remove", "origin");
    let engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Older computer-only delivery", description: "[quick]", delivery: "local", approveDelivery: false });
      await finish(engine, id);
      const delivered = await cleaned(engine, id);
      await engine.shutdown();
      // A saved delivery marked done left its copy behind, then the coordinator cancelled it.
      await ensureWorktree(w.clone, delivered.worktree!, delivered.branch!, "main");
      w.editSaved((state) => Object.assign(state.tasks.find((task) => task.id === id)!, {
        state: "cancelled", column: "done", statusLine: "Cancelled", shipping: undefined,
        cleanup: { pullRequest: "unconfirmed" },
      }));
      engine = w.start({ checkEveryMs: 100 });
      const task = await cleaned(engine, id);
      gone(w, task);
      expect(task.state).toBe("cancelled");
      expect(task.cleanup?.pullRequest).toBe("none");
      expect(w.github().calls).toEqual([]);
    } finally { await engine.shutdown(); }
  });

  it("saves local delivery and all history before removing packages and build output; reading after restart creates nothing", async () => {
    const w = world("local");
    let engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "local", true);
      const other = join(w.data, "worktrees", productId, "other");
      await ensureWorktree(w.clone, other, "petrina/other", "main");
      const id = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
      expect(taskOf(await finish(engine, id), id).state).toBe("done");
      const task = await cleaned(engine, id);
      gone(w, task);
      expect(existsSync(other)).toBe(true);
      expect(readFileSync(join(w.clone, "greeting.txt"), "utf8")).toContain("Hello");
      expect(git(w.clone, "rev-parse", "main")).toBe(git(w.clone, "rev-parse", task.branch!));
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(git(w.clone, "rev-parse", task.branch!));
      expect(texts(task).findIndex((line) => line.startsWith("Petrina pushed main to GitHub"))).toBeLessThan(texts(task).indexOf(CLEANUP_WORDS.removed));
      expect(task.brief).toBeDefined();
      expect(task.findings.length).toBeGreaterThan(0);
      expect(task.session.length).toBeGreaterThan(0);
      expect(texts(task).at(-1)).toBe(CLEANUP_WORDS.removed);
      const turns = engine.tracking.log.turns({ taskId: id });
      const moments = engine.tracking.log.moments({ taskId: id });
      const usage = engine.usage({ view: "task", taskId: id });
      expect(turns.length).toBeGreaterThan(0);
      expect(moments.filter((entry) => entry.kind === "task-end").map((entry) => entry.outcome)).toEqual(["delivered"]);
      expect(usage.stages.length).toBeGreaterThan(0);
      await engine.shutdown();
      engine = w.start();
      const saved = taskOf(engine.getState(), id);
      expect(engine.tracking.log.turns({ taskId: id })).toEqual(turns);
      expect(engine.tracking.log.moments({ taskId: id })).toEqual(moments);
      expect(engine.usage({ view: "task", taskId: id })).toEqual(usage);
      for (const key of ["timeline", "session", "brief", "findings", "landed", "report", "cleanup"] as const) expect(saved[key]).toEqual(task[key]);
      await Bun.sleep(150);
      expect(taskOf(engine.getState(), id).agent).toBeUndefined();
      gone(w, saved);
    } finally { engine.shutdown(); }
  });

  it("removes a verified release's copy and keeps its branch, tag and link", async () => {
    const w = world("release");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Release a greeting", description: "[quick]", delivery: "release", approveDelivery: false });
      expect(taskOf(await finish(engine, id), id).state).toBe("done");
      const task = await cleaned(engine, id);
      gone(w, task);
      expect(task.release?.url).toContain("/releases/tag/");
      expect(remoteRef(w.remote, `refs/tags/${task.release!.tag}`)).toBe(git(w.clone, "rev-parse", task.branch!));
      expect(texts(task).findIndex((line) => line.startsWith("Petrina published release"))).toBeLessThan(texts(task).indexOf(CLEANUP_WORDS.removed));
    } finally { engine.shutdown(); }
  });

  it("still frees space when the disk cannot save the verified delivery until its copy is gone", async () => {
    const w = world("full-disk");
    const engine = w.start();
    const save = engine.store.save.bind(engine.store);
    let failed = 0;
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Free space", description: "[quick]", delivery: "local", approveDelivery: false });
      engine.store.save = (state) => {
        const task = taskOf(state, id);
        if (task.state === "done" && existsSync(task.worktree!)) { failed += 1; throw new Error("disk full"); }
        save(state);
      };
      const task = await cleaned(engine, id);
      expect(failed).toBeGreaterThan(0);
      expect(task.state).toBe("done");
      expect(task.error).toBeUndefined();
      gone(w, task);
      engine.commitNow();
    } finally { engine.store.save = save; engine.shutdown(); }
  });

  it("cancels a running builder, waits for its background build, and removes any folder that comes back quietly", async () => {
    const w = world("cancel");
    const hold = join(w.dir, "builder-hold");
    const pids = join(w.dir, "build-pids");
    writeFileSync(hold, "");
    w.setScript((script) => { script.hold = { title: "Long build", file: hold }; script.background = { title: "Long build", pids }; });
    const engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Long build", description: "[quick]", delivery: "local" });
      await until(engine, () => existsSync(`${hold}.reached`), coordinator());
      const before = taskOf(engine.getState(), id);
      await waitForFile(join(before.worktree!, "target", "background", "out.bin"));
      const pid = Number(readFileSync(pids, "utf8").trim());
      engine.cancel(id);
      const task = await cleaned(engine, id);
      expect(task.state).toBe("cancelled");
      expect(() => process.kill(pid, 0)).toThrow();
      gone(w, task);
      expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
      const count = texts(task).length;
      mkdirSync(join(task.worktree!, "target"), { recursive: true });
      writeFileSync(join(task.worktree!, "target", "late.bin"), "late output");
      await waitFor(() => !existsSync(task.worktree!), "late output to go");
      expect(texts(taskOf(engine.getState(), id))).toHaveLength(count);
    } finally { rmSync(hold, { force: true }); engine.shutdown(); }
  });

  it("keeps open pull requests through checks, restart and cancellation, then records merged and closed separately", async () => {
    const w = world("pull-requests");
    let engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const ids: string[] = [];
      for (const title of ["Merge this", "Close this", "Cancel this"]) {
        const id = engine.addTask({ productId, title, description: "[quick]", approveDelivery: false });
        expect(taskOf(await finish(engine, id), id).state).toBe("pr-open");
        ids.push(id);
      }
      engine.cancel(ids[2]!);
      w.setGitHub((github) => (github.offline = true));
      engine.shutdown();
      engine = w.start({ checkEveryMs: 100 });
      await Bun.sleep(350);
      for (const id of ids) {
        const task = taskOf(engine.getState(), id);
        expect(task.cleanup).toBeUndefined();
        expect(existsSync(join(task.worktree!, "node_modules", "left-pad"))).toBe(true);
        expect(existsSync(join(task.worktree!, "target", "debug"))).toBe(true);
      }
      w.setGitHub((github) => { github.offline = false; github.prs.forEach((pr, index) => (pr.state = index === 0 ? "MERGED" : "CLOSED")); });
      const tasks = await Promise.all(ids.map((id) => cleaned(engine, id)));
      for (const task of tasks) gone(w, task);
      expect(tasks.map((task) => [task.state, task.pr?.state])).toEqual([["done", "merged"], ["done", "closed"], ["cancelled", "closed"]]);
      expect(ids.map((id) => engine.tracking.log.moments({ taskId: id, kinds: ["task-end"] }).map((entry) => entry.outcome))).toEqual([
        ["delivered", "merged"], ["delivered", "closed"], ["delivered", "cancelled", "closed"],
      ]);
      expect(texts(tasks[1]!)).toContain("Closed #2 without merging");
      expect(tasks[2]!.statusLine).toBe("Cancelled");
      expect(w.github().calls.every((call) => !call.includes("merge") && !call.includes("close"))).toBe(true);
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    } finally { engine.shutdown(); }
  });

  it("holds a copy cancelled while GitHub opens its pull request until GitHub can answer", async () => {
    const w = world("opening");
    const hold = join(w.dir, "opening");
    writeFileSync(hold, "");
    w.setGitHub((github) => (github.hold = { command: "pr create", file: hold }));
    let engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Open slowly", description: "[quick]", approveDelivery: false });
      await until(engine, () => existsSync(`${hold}.reached`));
      engine.cancel(id);
      w.setGitHub((github) => (github.offline = true));
      rmSync(hold);
      await until(engine, () => !engine.settling.has(id));
      expect(taskOf(engine.getState(), id).shipping?.step).toBe("open");
      expect(existsSync(taskOf(engine.getState(), id).worktree!)).toBe(true);
      const warning = CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmed);
      expect(texts(taskOf(engine.getState(), id)).filter((line) => line === warning)).toHaveLength(1);
      expect(taskOf(engine.getState(), id).cleanup?.error).toBe(CLEANUP_WORDS.unconfirmed);
      const calls = () => w.github().calls.filter((call) => call[0] === "pr" && call[1] === "list").length;
      const before = calls();
      await until(engine, () => calls() >= before + 2);
      engine.shutdown();
      engine = w.start({ checkEveryMs: 100 });
      await until(engine, () => calls() >= before + 3);
      expect(texts(taskOf(engine.getState(), id)).filter((line) => line === warning)).toHaveLength(1);
      expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
      expect(existsSync(taskOf(engine.getState(), id).worktree!)).toBe(true);
      w.setGitHub((github) => { github.offline = false; github.prs[0]!.baseRefName = "another-base"; });
      await until(engine, (s) => taskOf(s, id).pr?.state === "open");
      expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
      w.setGitHub((github) => (github.prs[0]!.state = "CLOSED"));
      gone(w, await cleaned(engine, id));
      expect(taskOf(engine.getState(), id).state).toBe("cancelled");
    } finally { rmSync(hold, { force: true }); engine.shutdown(); }
  });

  it("cleans a cancelled publishing step when GitHub confirms it never opened a pull request", async () => {
    const w = world("no-pull-request");
    w.setGitHub((github) => (github.fail = { "pr create": 1 }));
    const engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Never opened", description: "[quick]", approveDelivery: false });
      expect(taskOf(await finish(engine, id), id).state).toBe("failed");
      engine.cancel(id);
      const task = await cleaned(engine, id);
      expect(task.state).toBe("cancelled");
      expect(task.pr).toBeUndefined();
      gone(w, task);
    } finally { engine.shutdown(); }
  });

  it("retries a locked copy once a minute without crowding the timeline, then succeeds", async () => {
    if (process.platform === "win32") return; // Windows read-only directories do not prevent deletion.
    const w = world("retry");
    w.setScript((script) => (script.locked = "Locked build"));
    const engine = w.start({ checkEveryMs: 100 });
    let locked: string | undefined;
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Locked build", description: "[quick]", delivery: "local", approveDelivery: false });
      await until(engine, (s) => !!taskOf(s, id).cleanup?.error);
      let task = taskOf(engine.getState(), id);
      locked = join(task.worktree!, "target", "locked");
      expect(task.state).toBe("done");
      expect(task.cleanup?.removedAt).toBeUndefined();
      expect(listed(w, task.worktree!)).toBe(true);
      const timeline = task.timeline;
      await Bun.sleep(350);
      expect(taskOf(engine.getState(), id).timeline).toEqual(timeline);
      expect(texts(task).at(-1)).toBe(CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));
      expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
      chmodSync(locked, 0o755);
      task = await cleaned(engine, id);
      gone(w, task);
      expect(texts(task).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    } finally { if (locked && existsSync(locked)) chmodSync(locked, 0o755); engine.shutdown(); }
  });

  it("catches up older tasks across products at startup while a stalled pull request leaves others free", async () => {
    const w = world("catch-up");
    let engine = w.start();
    const hold = join(w.dir, "stalled");
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Old copy", description: "[quick]", approveDelivery: false });
      const task = structuredClone(taskOf(await finish(engine, id), id));
      const cancelled = engine.addTask({ productId, title: "Older cancelled copy", description: "[quick]", approvePlan: true });
      // The plan check is editable before any copy exists. Approve it, then pause once the copy is there.
      const planned = await until(engine, (s) => !!itemOf(s, cancelled, "plan"), () => {});
      expect(taskOf(planned, cancelled).worktree).toBeUndefined();
      engine.approve(itemOf(planned, cancelled, "plan")!.id);
      await until(engine, (s) => !!taskOf(s, cancelled).worktree, () => {});
      engine.pause(cancelled);
      await until(engine, () => !engine.settling.has(cancelled), () => {});
      engine.shutdown();
      const base = task.branch!;
      // Stand in for older saved tasks, including a second product and all states that must retain a copy.
      w.editSaved((state) => {
        (state.pool as { paused: boolean }).paused = true;
        (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== cancelled);
        const rows = state.tasks as unknown as Record<string, unknown>[];
        rows.find((row) => row.id === id)!.pr = { ...task.pr, number: 101 };
        Object.assign(rows.find((row) => row.id === cancelled)!, { state: "cancelled", column: "done" });
        const products = state.products as unknown as Record<string, unknown>[];
        products.push({ ...products[0], id: "second-product" });
        for (const status of ["done", "running", "paused", "failed", "queued", "needs-you"]) rows.push({ ...task, id: `older-${status}`, productId: "second-product", state: status === "running" ? "paused" : status, held: true, agent: undefined, pr: undefined, worktree: join(w.data, "worktrees", "second-product", status), branch: `petrina/older-${status}` });
      });
      for (const status of ["done", "running", "paused", "failed", "queued", "needs-you"]) await ensureWorktree(w.clone, join(w.data, "worktrees", "second-product", status), `petrina/older-${status}`, base);
      // As if cleanup stopped after deleting the folder, before dropping its repository record.
      const interrupted = join(w.data, "worktrees", "second-product", "done");
      rmSync(interrupted, { recursive: true, force: true });
      expect(listed(w, interrupted)).toBe(true);
      w.setGitHub((github) => {
        const first = github.prs[0]!;
        github.prs = [{ ...first, number: 101, state: "OPEN" }, { ...first, number: 102, state: "CLOSED" }];
        github.hold = { command: "pr view", file: hold, match: "101" };
      });
      const closedPath = join(w.data, "worktrees", productId, "closed");
      await ensureWorktree(w.clone, closedPath, "petrina/older-closed", base);
      w.editSaved((state) => (state.tasks as unknown as Record<string, unknown>[]).push({ ...task, id: "older-closed", worktree: closedPath, branch: "petrina/older-closed", pr: { ...task.pr, number: 102 } }));
      writeFileSync(hold, "");
      engine = w.start(); // All of this must happen on startup, before the first minute passes.
      await waitForFile(`${hold}.reached`);
      for (const key of [cancelled, "older-done", "older-closed"]) {
        const row = await cleaned(engine, key);
        gone(w, row);
      }
      expect(existsSync(task.worktree!)).toBe(true);
      for (const status of ["running", "paused", "failed", "queued", "needs-you"]) expect(existsSync(join(w.data, "worktrees", "second-product", status))).toBe(true);
    } finally { rmSync(hold, { force: true }); engine.shutdown(); }
  });

  it("says nothing about a copy when cancelled before setup, and safely completes an interrupted removal", async () => {
    const w = world("setup");
    const engine = w.start({ checkEveryMs: 100 });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Cancel before setup" });
      engine.cancel(id);
      await until(engine, () => !engine.settling.has(id));
      const task = taskOf(engine.getState(), id);
      expect(task.worktree).toBeUndefined();
      expect(texts(task).some((line) => /working copy|will try again/i.test(line))).toBe(false);
      expect(existsSync(join(w.data, "worktrees", productId, id))).toBe(false);
      const path = join(w.data, "worktrees", productId, "interrupted");
      const branch = branchName("Interrupted", "old");
      await ensureWorktree(w.clone, path, branch, "main");
      rmSync(path, { recursive: true, force: true });
      expect(listed(w, path)).toBe(true);
      expect(await removeWorktree(w.clone, path)).toBe(true);
      expect(listed(w, path)).toBe(false);
      expect(await removeWorktree(w.clone, path)).toBe(false);
      expect(git(w.clone, "rev-parse", branch)).toBe(w.initial);
    } finally { engine.shutdown(); }
  });
});
