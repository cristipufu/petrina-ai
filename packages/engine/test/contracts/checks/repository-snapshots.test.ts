import type { CheckVerification } from "../../../src/product-checks.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { git, removeDir, waitFor, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  for (const changed of [false, true]) it(`reuses captured tree and commit message for hooks${changed ? " when the hook changes during its run" : ", keeping message files inside the task diagnostics folder"}`, async () => {
    const { engine, task } = await fixture(`captured-hook-inputs-${changed}`, { git: ["first"] });
    const scope = executionFor(task), path = scope.work.worktree!, base = await git(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "hooked.txt"), "A product change\n");
    await git(path, "add", "."); await git(path, "commit", "-qm", "The checked commit message");
    scope.work.baseSha = base; scope.work.branch = "main";
    const hook = join(path, ".git", "hooks", "commit-msg"), recorded = join(engine.dataDir, "hook-message-path"), body = join(engine.dataDir, "hook-message-body");
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$1" > ${quote(recorded)}\ncat "$1" > ${quote(body)}\n${changed ? `printf '# Changed hook definition\\n' >> "$0"\n` : ""}`, { mode: 0o755 });
    const messages = spyOn(gitOps, "message");
    const state = await engine["checks"]["captureState"](scope, []);
    const heads = spyOn(gitOps, "head"), trees = spyOn(gitOps, "treeOf");
    try {
      engine.setPoolPaused(false);
      expect(state.message).toBe("The checked commit message");
      expect(nonpassingChecks(await engine["checks"].runProductChecks(scope, [], new AbortController().signal, undefined, state))).toBe(0);
      expect(messages).toHaveBeenCalledTimes(1);
      expect(heads).not.toHaveBeenCalled(); expect(trees).not.toHaveBeenCalled();
      expect(readFileSync(body, "utf8")).toBe("The checked commit message\n");
      const messagePath = readFileSync(recorded, "utf8");
      expect(dirname(dirname(messagePath))).toBe(join(engine.dataDir, "checks", task.id));
      expect(existsSync(messagePath)).toBe(false);
      expect(scope.work.checks).toMatchObject({ current: !changed, sha: state.sha, tree: state.tree });
      expect(task.journey!.at(-1)!.checkAttempts![0]).toMatchObject({ passed: !changed, sha: state.sha, tree: state.tree, definition: state.definition });
    } finally { messages.mockRestore(); heads.mockRestore(); trees.mockRestore(); await engine.shutdown(); }
  });

  it("pins reusable check tree and hook-message inputs to the observed commit", async () => {
    const { engine, task } = await fixture("pinned-check-snapshot", { git: ["first"] });
    const scope = executionFor(task), path = scope.work.worktree!, before = await git(path, "rev-parse", "HEAD"), tree = await git(path, "rev-parse", "HEAD^{tree}"), message = await git(path, "log", "-1", "--format=%B");
    writeFileSync(join(path, ".git", "hooks", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const status = gitOps.worktreeStatus;
    const read = spyOn(gitOps, "worktreeStatus").mockImplementation(async file => {
      const observed = await status(file);
      writeFileSync(join(path, "moved-head.txt"), "HEAD moved after the status observation\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "A later commit");
      return observed;
    });
    try {
      const captured = await engine["checks"]["captureState"](scope, []);
      expect(await git(path, "rev-parse", "HEAD")).not.toBe(before);
      expect(captured).toMatchObject({ sha: before, tree, message });
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  it("captures check status, pinned tree and hook paths with two Git launches and no persistent cache", async () => {
    const { engine, task } = await fixture("check-input-budget", { git: ["first"] });
    try {
      const scope = executionFor(task), path = scope.work.worktree!;
      const sha = await git(path, "rev-parse", "HEAD"), tree = await git(path, "rev-parse", "HEAD^{tree}");
      let calls = 0;
      const native = Bun.spawn, watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        if (args[0][0] === "git") calls++;
        return Reflect.apply(native, Bun, args);
      }) as typeof Bun.spawn);
      try {
        const first = await engine["checks"]["captureState"](scope, []);
        expect(first).toMatchObject({ sha, tree, trackedChanged: false, hooks: [] });
        expect(calls).toBe(2);
        writeFileSync(join(path, "README.md"), "Tracked work changed after observation\n");
        const second = await engine["checks"]["captureState"](scope, []);
        expect(second).toMatchObject({ sha, tree, trackedChanged: true, hooks: [] });
        expect(calls).toBe(4);
      } finally { watch.mockRestore(); }
    } finally { await engine.shutdown(); }
  });

  for (const current of [false, true]) it(`keeps check evidence ${current ? "honest after an agent commits its own edits" : "stale without re-reading an unchanged tree"}`, async () => {
    const { engine, task } = await fixture(`save-role-evidence-${current}`, { git: ["first"] });
    const scope = executionFor(task), path = scope.work.worktree!;
    scope.work.checks = { current, at: 1, tree: await git(path, "rev-parse", "HEAD^{tree}"), results: [] };
    if (current) {
      writeFileSync(join(path, "agent-commit.txt"), "Committed by the agent before handoff\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "Agent's own commit");
    }
    const trees = spyOn(gitOps, "treeOf"), versions = spyOn(gitOps, "commitVersion");
    try {
      await engine.saveRoleEdits(scope, "builder", "sol-high");
      expect(scope.work.checks.current).toBe(false);
      expect(trees).not.toHaveBeenCalled();
      expect(versions).toHaveBeenCalledTimes(1);
      expect(scope.work.savedVersion).toEqual({ commit: await git(path, "rev-parse", "HEAD"), tree: await git(path, "rev-parse", "HEAD^{tree}") });
    } finally { trees.mockRestore(); versions.mockRestore(); await engine.shutdown(); }
  });

  it("does not upgrade unavailable, partial, malformed or rejected saved-role observations into current proof", async () => {
    const { engine, task } = await fixture("save-role-unknown", { git: ["first"] });
    const scope = executionFor(task), path = scope.work.worktree!;
    const saved = { commit: await git(path, "rev-parse", "HEAD"), tree: await git(path, "rev-parse", "HEAD^{tree}") };
    try {
      // These failure permutations inspect the same untouched private repository; none may change it.
      for (const observed of ["unavailable", "head-only", "tree-only", "malformed", "rejected"] as const) {
        scope.work.savedVersion = { ...saved };
        scope.work.checks = { current: true, at: 1, ...(observed === "unavailable" || observed === "head-only" ? {} : { tree: saved.tree }), results: [] };
        const failure = new Error("The paired repository observation failed");
        const value = observed === "head-only" ? { head: saved.commit } : observed === "tree-only" ? { tree: saved.tree }
          : observed === "malformed" ? { head: "not-a-commit", tree: saved.tree } : {};
        const versions = spyOn(gitOps, "commitVersion");
        if (observed === "rejected") versions.mockRejectedValue(failure); else versions.mockResolvedValue(value);
        const trees = spyOn(gitOps, "treeOf"), heads = spyOn(gitOps, "head");
        try {
          if (observed === "rejected") expect(await rejectionOf(engine.saveRoleEdits(scope, "builder", "sol-high"))).toBe(failure);
          else {
            await engine.saveRoleEdits(scope, "builder", "sol-high");
          }
          expect(scope.work.checks.current).toBe(false);
          expect(versions).toHaveBeenCalledTimes(1);
          expect(trees).not.toHaveBeenCalled(); expect(heads).not.toHaveBeenCalled();
          // Explicit history: extra validation compares fresh HEAD before queueing this exact snapshot.
          expect(scope.work.savedVersion).toEqual(saved);
        } catch (error) { console.error(`Saved-role ${observed} control failed`); throw error; }
        finally { versions.mockRestore(); trees.mockRestore(); heads.mockRestore(); }
      }
    } finally { await engine.shutdown(); }
  });

  for (const hooks of [false, true]) it(`restores checks with one combined inspection${hooks ? " and verifies a hook's reverted commit" : ", retaining untracked build output"}`, async () => {
    const { engine, task } = await fixture(`post-check-${hooks}`, { git: ["first"] });
    const scope = executionFor(task, "first"), path = scope.work.worktree!;
    const sha = await git(path, "rev-parse", "HEAD"), tree = await git(path, "rev-parse", "HEAD^{tree}");
    const original = await git(path, "show", "HEAD:README.md");
    const checksToRun = hooks ? [] : [{ name: "Build", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('check-artifact.txt', 'Build output\\n')"] }];
    engine.setPoolPaused(false);
    const prepared = await engine["checks"]["captureState"](scope, checksToRun);
    const inspections = spyOn(gitOps, "worktreeStatus"), heads = spyOn(gitOps, "head");
    const checks = engine["checks"], hook = checks["runHooks"];
    checks["runHooks"] = async () => {
      if (hooks) {
        writeFileSync(join(path, "README.md"), "A hook changed the product\n");
        await git(path, "add", "."); await git(path, "commit", "-qm", "An unapproved hook commit");
      }
      return [];
    };
    // A run with nothing to run touches no file at all; a real check gets exactly one combined inspection afterwards.
    try {
      expect(nonpassingChecks(await engine["checks"]["runAll"](scope, checksToRun, { ...prepared, sha, tree, trackedChanged: false, hooks: hooks ? ["pre-commit"] : [], definition: "test" }, new AbortController().signal, new Map()))).toBe(0);
      expect(heads).not.toHaveBeenCalled();
      expect(inspections).toHaveBeenCalledTimes(hooks ? 3 : 1);
      expect(scope.work.checks).toMatchObject({ current: false, sha, tree, results: hooks ? [] : [expect.objectContaining({ name: "Build", ok: true })] });
      expect(await git(path, "rev-parse", "HEAD")).toBe(sha);
      expect(await git(path, "show", "HEAD:README.md")).toBe(original);
      if (!hooks) expect(await git(path, "status", "--porcelain")).toContain("check-artifact.txt");
    } finally { checks["runHooks"] = hook; heads.mockRestore(); inspections.mockRestore(); await engine.shutdown(); }
  });

  it("does not attach current check evidence to the old commit when restoring a hook's commit fails", async () => {
    const { engine, task } = await fixture("failed-post-check-restore", { git: ["first"] });
    const scope = executionFor(task, "first"), path = scope.work.worktree!, sha = await git(path, "rev-parse", "HEAD");
    engine.setPoolPaused(false);
    const prepared = await engine["checks"]["captureState"](scope, []);
    scope.work.checks = { at: 1, current: true, sha, results: [] };
    const checks = engine["checks"], hook = checks["runHooks"];
    checks["runHooks"] = async () => {
      writeFileSync(join(path, "README.md"), "A hook commit that cannot be reverted\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "Unexpected commit");
      return [];
    };
    const reset = spyOn(gitOps, "resetTo").mockResolvedValue(undefined);
    try {
      await expectRejection(engine["checks"]["runAll"](scope, [], { ...prepared, sha, trackedChanged: false, hooks: ["pre-commit"], definition: "test" }, new AbortController().signal, new Map()), "could not restore the original work");
      expect(scope.work.checks).toMatchObject({ sha, current: false });
      expect(await git(path, "rev-parse", "HEAD")).not.toBe(sha);
    } finally { reset.mockRestore(); checks["runHooks"] = hook; await engine.shutdown(); }
  });

  it("observes check inputs once per gate and rechecks freshness instead of trusting a saved current flag", async () => {
    const { engine, task } = await fixture("check-observations", { git: ["first"] });
    const probe = spyOn(gitOps, "worktreeStatus");
    try {
      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      const commands = [{ name: "Quick check", argv: [process.execPath, "-e", "console.log('Checked')"] }];
      engine.s.products.find((product) => product.id === "first")!.checks = commands;
      expect((await checks.failing(scope, signal, commands)).kind).toBe("passed");
      // One gate observation plus one combined inspection after the command.
      expect(probe).toHaveBeenCalledTimes(2);
      const attempt = task.journey!.at(-1)!.checkAttempts![0]!;
      expect(attempt).toMatchObject({ passed: true, sha: scope.work.checks!.sha, tree: scope.work.checks!.tree, definition: scope.work.checks!.definition });
      expect((await checks.failing(scope, signal, commands)).kind).toBe("passed");
      expect(probe).toHaveBeenCalledTimes(3);
      expect(task.journey!.at(-1)!.checkAttempts).toHaveLength(1);
      expect(scope.work.checks!.current).toBe(true);
      writeFileSync(join(scope.work.worktree!, "README.md"), "A tracked change after the checks\n");
      expect((await checks.current(scope)).inputs.kind).not.toBe("matches");
      expect(probe).toHaveBeenCalledTimes(4);
      expect(attempt.passed).toBe(true);
    } finally { probe.mockRestore(); await engine.shutdown(); }
  });

  it("finishes a queued check against its bound owner after the task's current product changes", async () => {
    const { engine, task } = await fixture("queued-check", { git: ["first","second"] });
    let release: (() => void) | undefined;
    let pending: Promise<CheckVerification> | undefined;
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"];
      const signal = new AbortController().signal;
      release = await checks["turnToRun"](second, signal);
      pending = checks.runProductChecks(first, [{ name: "First product only", argv: [process.execPath, "-e", "console.error('Failure from the first product'); process.exit(1)"] }], signal);
      await waitFor(() => engine.checkQueue.waiting === 1, "the first product's check to queue");
      writeFileSync(join(first.work.worktree!, "queued-change.txt"), "Committed while checks waited\n");
      await git(first.work.worktree!, "add", "."); await git(first.work.worktree!, "commit", "-qm", "Keep the change made while checks waited");
      const queuedHead = await gitOps.head(first.work.worktree!);
      const hook = join(first.work.worktree!, ".git", "hooks", "commit-msg");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755);
      task.activeProductId = "second";
      engine.getState(); engine.windowState(); engine.taskDetails(task.id); engine.commitNow();
      release(); release = undefined;
      expect(nonpassingChecks(await pending!)).toBe(1);
      expect(await gitOps.head(first.work.worktree!)).toBe(queuedHead);
      expect(engine.s.products.find((product) => product.id === "first")!.hooks).toEqual(["commit-msg"]);
      expect(first.work.checks!.results[0]!.output).toContain("Failure from the first product");
      expect(second.work.checks).toBeUndefined();
      expect(Object.hasOwn(task, "checks")).toBe(false);
      expect(task.findings.filter((finding) => finding.raisedBy === "petrina").map((finding) => finding.productIds)).toEqual([["first"]]);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).length).toBeGreaterThan(0);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).every((line) => line.productId === "first")).toBe(true);
      expect(engine.taskDetails(task.id)!.checks).toBeUndefined();
      engine.save();
      expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.repositories![0]!.checks!.results[0]!.ok).toBe(false);
    } finally { release?.(); await pending?.catch(() => {}); await engine.shutdown(); }
  });
});
