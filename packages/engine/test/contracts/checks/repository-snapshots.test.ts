import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { CheckVerification } from "../../../src/product-checks.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";
import { describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "@petrina/core";
import { gitCommand, writeGitProgram } from "@petrina/test-support/git-program";
import { waitFor } from "../../support.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";

const worktreeVersion = (path: string) => {
  const { commit, tree } = readWorktreeCommit(path)!;
  return { commit, tree };
};

/** A real commit-msg hook changes the branch; pre-commit's detached copy restores itself. */
function committingHook(path: string, dataDir: string): void {
  const script = join(dataDir, "committing-hook.ts"), emptyHooks = join(dataDir, "nested-hooks-off");
  mkdirSync(emptyHooks, { recursive: true });
  writeFileSync(script, `import { writeFileSync } from "node:fs";
import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
writeFileSync("README.md", "A hook changed the product\\n");
await git(process.cwd(), "add", "README.md");
await git(process.cwd(), "-c", ${JSON.stringify(`core.hooksPath=${emptyHooks}`)}, "commit", "-qm", "An unapproved hook commit");`);
  writeGitProgram(join(path, ".git", "hooks", "commit-msg"), `exec ${gitCommand([{ path: process.execPath }, { path: script }])}`);
}

describe("explicit repository execution contexts", () => {
  for (const changed of [false, true]) it(`reuses captured tree and commit message for hooks${changed ? " when the hook changes during its run" : ", keeping message files inside the task diagnostics folder"}`, async () => {
    await withRepositoryRecords(`captured-hook-inputs-${changed}`, { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task), path = scope.work.worktree!, base = readWorktreeCommit(path)!.commit;
      writeFileSync(join(path, "hooked.txt"), "A product change\n");
      await gitOps.commitChanges(path, "The checked commit message");
      scope.work.baseSha = base; scope.work.branch = "main";
      const hook = join(path, ".git", "hooks", "commit-msg"), recorded = join(engine.dataDir, "hook-message-path"), body = join(engine.dataDir, "hook-message-body");
      const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
      writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$1" > ${quote(recorded)}\ncat "$1" > ${quote(body)}\n${changed ? `printf '# Changed hook definition\\n' >> "$0"\n` : ""}`, { mode: 0o755 });
      const messages = spyOn(gitOps, "message");
      try {

        const state = await engine["checks"]["captureState"](scope, []);
        const heads = spyOn(gitOps, "head");
        try {
          const trees = spyOn(gitOps, "treeOf");
          try {

            engine.setPoolPaused(false);
            expect(state.message).toBe("The checked commit message");
            expect(nonpassingChecks(await ownRun(() => engine["checks"].runProductChecks(scope, [], engine.stopRequested.signal, undefined, state)))).toBe(0);
            expect(messages).toHaveBeenCalledTimes(1);
            expect(heads).not.toHaveBeenCalled(); expect(trees).not.toHaveBeenCalled();
            expect(readFileSync(body, "utf8")).toBe("The checked commit message\n");
            const messagePath = readFileSync(recorded, "utf8");
            expect(dirname(dirname(messagePath))).toBe(join(engine.dataDir, "checks", task.id));
            expect(existsSync(messagePath)).toBe(false);
            expect(scope.work.checks).toMatchObject({ current: !changed, sha: state.sha, tree: state.tree });
            expect(task.journey!.at(-1)!.checkAttempts![0]).toMatchObject({ passed: !changed, sha: state.sha, tree: state.tree, definition: state.definition });

          } finally { trees.mockRestore(); }
        } finally { heads.mockRestore(); }
      } finally { messages.mockRestore(); }
    });
  });

  it("pins reusable check tree and hook-message inputs to the observed commit", async () => {
    await withRepositoryRecords("pinned-check-snapshot", { git: ["first"] }, async ({ engine, task }) => {
      const scope = executionFor(task), path = scope.work.worktree!, { commit: before, tree } = readWorktreeCommit(path)!, message = await gitOps.message(path);
      writeFileSync(join(path, ".git", "hooks", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const status = gitOps.worktreeStatus;
      const read = spyOn(gitOps, "worktreeStatus");
      try {
        read.mockImplementation(async file => {
          const observed = await status(file);
          writeFileSync(join(path, "moved-head.txt"), "HEAD moved after the status observation\n");
          await gitOps.commitChanges(path, "A later commit");
          return observed;
        });

        const captured = await engine["checks"]["captureState"](scope, []);
        expect(readWorktreeCommit(path)!.commit).not.toBe(before);
        expect(captured).toMatchObject({ sha: before, tree, message });

      } finally { read.mockRestore(); }
    });
  });

  it("captures check status, pinned tree and hook paths with two Git launches and no persistent cache", async () => {
    await withRepositoryRecords("check-input-budget", { git: ["first"] }, async ({ engine, task }) => {

      const scope = executionFor(task), path = scope.work.worktree!;
      const { commit: sha, tree } = readWorktreeCommit(path)!;
      let calls = 0;
      const native = Bun.spawn;
      const watch = spyOn(Bun, "spawn");
      try {
        watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
          if (args[0][0] === "git") calls++;
          return Reflect.apply(native, Bun, args);
        }) as typeof Bun.spawn);

        const first = await engine["checks"]["captureState"](scope, []);
        expect(first).toMatchObject({ sha, tree, trackedChanged: false, hooks: [] });
        expect(calls).toBe(2);
        writeFileSync(join(path, "README.md"), "Tracked work changed after observation\n");
        const second = await engine["checks"]["captureState"](scope, []);
        expect(second).toMatchObject({ sha, tree, trackedChanged: true, hooks: [] });
        expect(calls).toBe(4);

      } finally { watch.mockRestore(); }
    });
  });

  it("saves editing-role changes with one fresh paired version and no intermediate HEAD read", async () => {
    await withRepositoryRecords("saved-role-commit-budget", { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task), path = scope.work.worktree!;
      scope.work.checks = { current: true, at: 1, tree: readWorktreeCommit(path)!.tree, results: [] };
      writeFileSync(join(path, "saved-edit.txt"), "Saved before another role can clean up\n");
      const native = Bun.spawn;
      let reads = 0, watch: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
      let versions: ReturnType<typeof spyOn<typeof gitOps, "commitVersion">> | undefined;
      const cleanup = () => {
        const errors: unknown[] = [];
        for (const restore of [() => watch?.mockRestore(), () => versions?.mockRestore()]) try { restore(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Saved-role observation controls could not restore their boundaries");
      };
      await setupWithCleanup(async () => {
        versions = spyOn(gitOps, "commitVersion");
        watch = spyOn(Bun, "spawn");
        watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
          if (args[0][0] === "git" && args[1]?.cwd === path && args[0].includes("rev-parse")) {
            reads++;
            throw new Error("The save owner must use its paired version observation");
          }
          return Reflect.apply(native, Bun, args);
        }) as typeof Bun.spawn);
        await ownRun(() => engine.saveRoleEdits(scope, "builder", "sol-high"));
        expect(reads).toBe(0);
        expect(versions).toHaveBeenCalledTimes(1);
        expect(scope.work.checks?.current).toBe(false);
      }, cleanup);
      cleanup();
      expect(scope.work.savedVersion).toEqual(worktreeVersion(path));
      expect((await gitOps.fileAt(path, "HEAD", "saved-edit.txt"))!.trim()).toBe("Saved before another role can clean up");
      expect(task.timeline.some(entry => entry.text === "Saved the changes from the Builder on the task's branch")).toBe(true);
    });
  });

  for (const current of [false, true]) it(`keeps check evidence ${current ? "honest after an agent commits its own edits" : "stale without re-reading an unchanged tree"}`, async () => {
    await withRepositoryRecords(`save-role-evidence-${current}`, { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task), path = scope.work.worktree!;
      scope.work.checks = { current, at: 1, tree: readWorktreeCommit(path)!.tree, results: [] };
      if (current) {
        writeFileSync(join(path, "agent-commit.txt"), "Committed by the agent before handoff\n");
        await gitOps.commitChanges(path, "Agent's own commit");
      }
      const trees = spyOn(gitOps, "treeOf");
      try {
        const versions = spyOn(gitOps, "commitVersion");
        try {

          await ownRun(() => engine.saveRoleEdits(scope, "builder", "sol-high"));
          expect(scope.work.checks.current).toBe(false);
          expect(trees).not.toHaveBeenCalled();
          expect(versions).toHaveBeenCalledTimes(1);
          expect(scope.work.savedVersion).toEqual(worktreeVersion(path));

        } finally { versions.mockRestore(); }
      } finally { trees.mockRestore(); }
    });
  });

  it("does not upgrade unavailable, partial, malformed or rejected saved-role observations into current proof", async () => {
    await withRepositoryRecords("save-role-unknown", { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task), path = scope.work.worktree!;
      const saved = worktreeVersion(path);

      // These failure permutations inspect the same untouched private repository; none may change it.
      for (const observed of ["unavailable", "head-only", "tree-only", "malformed", "rejected"] as const) {
        scope.work.savedVersion = { ...saved };
        scope.work.checks = { current: true, at: 1, ...(observed === "unavailable" || observed === "head-only" ? {} : { tree: saved.tree }), results: [] };
        const failure = new Error("The paired repository observation failed");
        const value = observed === "head-only" ? { head: saved.commit } : observed === "tree-only" ? { tree: saved.tree }
        : observed === "malformed" ? { head: "not-a-commit", tree: saved.tree } : {};
        const versions = spyOn(gitOps, "commitVersion");
        try {

          if (observed === "rejected") versions.mockRejectedValue(failure); else versions.mockResolvedValue(value);
          const trees = spyOn(gitOps, "treeOf");
          try {
            const heads = spyOn(gitOps, "head");
            try {

              try {
                if (observed === "rejected") expect(await ownRun(() => rejectionOf(engine.saveRoleEdits(scope, "builder", "sol-high")))).toBe(failure);
                else {
                  await ownRun(() => engine.saveRoleEdits(scope, "builder", "sol-high"));
                }
                expect(scope.work.checks.current).toBe(false);
                expect(versions).toHaveBeenCalledTimes(1);
                expect(trees).not.toHaveBeenCalled(); expect(heads).not.toHaveBeenCalled();
                // Explicit history: extra validation compares fresh HEAD before queueing this exact snapshot.
                expect(scope.work.savedVersion).toEqual(saved);
              } catch (error) { console.error(`Saved-role ${observed} control failed`); throw error; }
              finally { }

            } finally { heads.mockRestore(); }
          } finally { trees.mockRestore(); }
        } finally { versions.mockRestore(); }
      }

    });
  });

  for (const hooks of [false, true]) it(`restores checks with one combined inspection${hooks ? " and verifies a hook's reverted commit" : ", retaining untracked build output"}`, async () => {
    await withRepositoryRecords(`post-check-${hooks}`, {
      git: ["first"],
      ...(hooks ? {} : {
        runCheckCommand: req => {
          if (req.argv[1] !== "-e") return undefined;
          writeFileSync(join(req.cwd, "check-artifact.txt"), "Build output\n");
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    }, async ({ engine, task, run }) => {
      const scope = executionFor(task, "first"), path = scope.work.worktree!;
      if (hooks) {
        scope.work.baseSha = readWorktreeCommit(path)!.commit; scope.work.branch = "main";
        writeFileSync(join(path, "task-change.txt"), "The task's committed change\n");
        await gitOps.commitChanges(path, "The checked task change");
        committingHook(path, engine.dataDir);
      }
      const { commit: sha, tree } = readWorktreeCommit(path)!;
      const original = (await gitOps.fileAt(path, "HEAD", "README.md"))!.trim();
      const checksToRun = hooks ? [] : [{ name: "Build", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('check-artifact.txt', 'Build output\\n')"] }];
      if (checksToRun.length) {
        const product = engine.s.products.find(product => product.id === "first")!;
        product.checks = checksToRun; product.checksBy = "coordinator";
      }
      engine.setPoolPaused(false);
      const prepared = await engine["checks"]["captureState"](scope, checksToRun);
      const inspections = spyOn(gitOps, "worktreeStatus");
      try {
        const heads = spyOn(gitOps, "head");
        // A run with nothing to run touches no file at all; a real check gets exactly one combined inspection afterwards.
        try {
          expect(nonpassingChecks(await run(() => engine["checks"].runProductChecks(scope, checksToRun, engine.stopRequested.signal, undefined, prepared)))).toBe(0);
          expect(heads).not.toHaveBeenCalled();
          expect(inspections).toHaveBeenCalledTimes(hooks ? 3 : 1);
          expect(scope.work.checks).toMatchObject({ current: true, sha, tree, results: [expect.objectContaining({ name: hooks ? "Commit message hook" : "Build", ok: true })] });
          expect(readWorktreeCommit(path)!.commit).toBe(sha);
          expect((await gitOps.fileAt(path, "HEAD", "README.md"))!.trim()).toBe(original);
        } finally { heads.mockRestore(); }
      } finally { inspections.mockRestore(); }
      if (!hooks) expect(existsSync(join(path, "check-artifact.txt")) && !(await gitOps.isClean(path))).toBe(true);
    });
  });

  it("does not attach current check evidence to the old commit when restoring a hook's commit fails", async () => {
    await withRepositoryRecords("failed-post-check-restore", { git: ["first"] }, async ({ engine, task, run }) => {
      const scope = executionFor(task, "first"), path = scope.work.worktree!;
      scope.work.baseSha = readWorktreeCommit(path)!.commit; scope.work.branch = "main";
      writeFileSync(join(path, "task-change.txt"), "The task's committed change\n");
      await gitOps.commitChanges(path, "The checked task change");
      committingHook(path, engine.dataDir);
      const sha = readWorktreeCommit(path)!.commit;
      engine.setPoolPaused(false);
      const prepared = await engine["checks"]["captureState"](scope, []);
      scope.work.checks = { at: 1, current: true, sha, results: [] };
      const reset = spyOn(gitOps, "resetTo");
      try {
        reset.mockResolvedValue(undefined);
        await run(() => expectRejection(engine["checks"].runProductChecks(scope, [], engine.stopRequested.signal, undefined, prepared), "could not restore the original work"));
        expect(scope.work.checks).toMatchObject({ sha, current: false });
        expect(readWorktreeCommit(path)!.commit).not.toBe(sha);
      } finally { reset.mockRestore(); }
    });
  });

  it("observes check inputs once per gate and rechecks freshness instead of trusting a saved current flag", async () => {
    await withRepositoryRecords("check-observations", {
      git: ["first"],
      runCheckCommand: req => req.argv[1] === "-e" ? { code: 0, stdout: "Checked\n", stderr: "" } : undefined,
    }, async ({ engine, task, run: ownRun }) => {
      const probe = spyOn(gitOps, "worktreeStatus");
      try {
        engine.setPoolPaused(false);
        const scope = executionFor(task, "first"), checks = engine["checks"], signal = engine.stopRequested.signal;
        const commands = [{ name: "Quick check", argv: [process.execPath, "-e", "console.log('Checked')"] }];
        engine.s.products.find((product) => product.id === "first")!.checks = commands;
        expect((await ownRun(() => checks.failing(scope, signal, commands))).kind).toBe("passed");
        // One gate observation plus one combined inspection after the command.
        expect(probe).toHaveBeenCalledTimes(2);
        const attempt = task.journey!.at(-1)!.checkAttempts![0]!;
        expect(attempt).toMatchObject({ passed: true, sha: scope.work.checks!.sha, tree: scope.work.checks!.tree, definition: scope.work.checks!.definition });
        expect((await ownRun(() => checks.failing(scope, signal, commands))).kind).toBe("passed");
        expect(probe).toHaveBeenCalledTimes(3);
        expect(task.journey!.at(-1)!.checkAttempts).toHaveLength(1);
        expect(scope.work.checks!.current).toBe(true);
        writeFileSync(join(scope.work.worktree!, "README.md"), "A tracked change after the checks\n");
        expect((await checks.current(scope)).inputs.kind).not.toBe("matches");
        expect(probe).toHaveBeenCalledTimes(4);
        expect(attempt.passed).toBe(true);
      } finally { probe.mockRestore(); }
    });
  });

  it("finishes a queued check against its bound owner after the task's current product changes", async () => {
    await withRepositoryRecords("queued-check", {
      git: ["first","second"],
      runCheckCommand: req => req.argv[1] === "-e" ? { code: 1, stdout: "", stderr: "Failure from the first product\n" } : undefined,
    }, async ({ engine, task, run }) => {
      let release: (() => void) | undefined;
      let pending: Promise<CheckVerification> | undefined;
      try {
        engine.setPoolPaused(false);
        const first = executionFor(task, "first"), second = executionFor(task, "second");
        first.work.baseSha = readWorktreeCommit(first.work.worktree!)!.commit; first.work.branch = "main";
        const checks = engine["checks"];
        const signal = engine.stopRequested.signal;
        const commands = [{ name: "First product only", argv: [process.execPath, "-e", "console.error('Failure from the first product'); process.exit(1)"] }];
        engine.setProductChecks("first", commands.map(check => ({ name: check.name, command: commandInputText(check.argv) })));
        release = await checks["turnToRun"](second, signal);
        pending = run(() => checks.runProductChecks(first, commands, signal));
        await waitFor(() => engine.checkQueue.waiting === 1, "the first product's check to queue", 30_000, { during: pending });
        writeFileSync(join(first.work.worktree!, "queued-change.txt"), "Committed while checks waited\n");
        await gitOps.commitChanges(first.work.worktree!, "Keep the change made while checks waited");
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
      } finally { release?.(); }
    });
  });
});
