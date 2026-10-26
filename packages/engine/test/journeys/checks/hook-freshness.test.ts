
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";


import { checkWorkflowFixtures, type CheckWorkflow } from "../../fixtures/check-workflow.js";
import { git, itemOf, taskOf, until } from "../../support.js";

const workflows = checkWorkflowFixtures();
afterAll(() => workflows.close());
const fixture = workflows.use;


describe.concurrent("failed checks are evidence until something changes", () => {
it.skipIf(process.platform === "win32")("checks a corrected commit title and changed local hook even when the code stays the same", async () => {
    await fixture("built", async f => {
      try {
        f.setCheck("--pass");
        const hook = join(f.repo, ".git", "hooks", "commit-msg");
        writeFileSync(hook, '#!/bin/sh\nhead -1 "$1" | grep -q "^Fix:" || { echo "Use Fix in the title"; exit 1; }\n');
        chmodSync(hook, 0o755);
        let task = await f.delivery();
        expect(f.runs()).toEqual(["passed"]);
        const tree = task.checks!.tree;
        expect(task.checks!.results.find((run) => run.name === "Commit message hook")?.ok).toBe(false);
        f.agents.scenario({ planner: "short", title: "Fix: Add a greeting" });
        f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Correct the title");
        task = await f.delivery();
        expect(task.checks!.tree).toBe(tree);
        expect(task.checks!.results.every((run) => run.ok)).toBe(true);
        expect(f.runs()).toEqual(["passed", "passed"]);
        // Local hooks live outside the tree, so changing one must invalidate a passing run too.
        writeFileSync(hook, '#!/bin/sh\necho "The changed hook ran"\n');
        f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
        const state = await until(f.engine, (state) => taskOf(state, f.taskId).state === "done");
        expect(taskOf(state, f.taskId).checks!.results.find((run) => run.name === "Commit message hook")?.output).toContain("The changed hook ran");
        expect(f.runs()).toEqual(["passed", "passed", "passed"]);
        expect(await f.run(() => git(f.repo, "log", "-1", "--format=%s"))).toBe("Fix: Add a greeting");
      } finally {
        await f.engine.shutdown();
      }
    });
  });

for (const hookName of ["pre-commit", "commit-msg"] as const) {
    async function externalHook(f: CheckWorkflow, pass: boolean) {
      const folder = join(f.root, "external-hooks");
      mkdirSync(folder);
      const launcher = join(folder, hookName);
      writeFileSync(launcher, '#!/bin/sh\nexec sh "$(dirname "$0")/implementation"\n');
      chmodSync(launcher, 0o755);
      await f.run(() => git(f.repo, "config", "core.hooksPath", folder));
      const set = (ok: boolean) => writeFileSync(join(folder, "implementation"), `dir=$(dirname "$0")\nprintf 'run\\n' >> "$dir/runs"\necho "External implementation: ${ok ? "passed" : "failed (captured hook failure)"}"\nexit ${ok ? 0 : 1}\n`);
      set(pass);
      return { launcher, set, runs: () => existsSync(join(folder, "runs")) ? readFileSync(join(folder, "runs"), "utf8").trim().split("\n").length : 0 };
    }

    it.skipIf(process.platform === "win32")(`revalidates a passing ${hookName} launcher, preserves a failure across restart, and refreshes it on explicit Retry`, async () => {
      await fixture("built", async f => {
        try {
          f.setCheck("--pass");
          const hook = await externalHook(f, true);
          const launcher = readFileSync(hook.launcher, "utf8");
          const passed = (await f.delivery()).checks!;
          const initialRuns = hook.runs();
          expect(initialRuns).toBeGreaterThan(0);
          expect(f.runs()).toEqual(["passed"]);
          hook.set(false);
          expect(readFileSync(hook.launcher, "utf8")).toBe(launcher);
          f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          const failed = (await f.delivery()).checks!;
          expect(failed.definition).toBe(passed.definition);
          expect(failed.tree).toBe(passed.tree);
          expect(failed.results.at(-1)!.output).toContain("captured hook failure");
          expect(failed.results.at(-1)!.ok).toBe(false);
          expect(hook.runs()).toBe(initialRuns + 1);
          expect(f.runs()).toEqual(["passed"]);

          // The implementation is opaque: unchanged failed evidence blocks until the coordinator retries.
          hook.set(true);
          await f.restart();
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the saved failure");
          expect((await f.delivery()).checks).toEqual(failed);
          expect(hook.runs()).toBe(initialRuns + 1);
          expect(f.runs()).toEqual(["passed"]);
          // Stand in for a later failure before the delivery question is raised again.
          f.engine.takeItem(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          f.engine.fail(f.taskId, new Error("Delivery could not start"));
          f.engine.setPoolPaused(true);
          await f.engine.retry(itemOf(f.engine.getState(), f.taskId, "stuck")!.id);
          const waiting = taskOf(f.engine.getState(), f.taskId).checks!;
          expect(waiting.results).toEqual(failed.results);
          expect(waiting.sha).toBeUndefined();
          expect(waiting.tree).toBeUndefined();
          f.engine.setPoolPaused(false);
          const refreshed = (await f.delivery()).checks!;
          expect(refreshed.results.every((run) => run.ok)).toBe(true);
          expect(hook.runs()).toBeGreaterThan(initialRuns + 1);
          expect(f.runs()).toEqual(["passed", "passed"]);
        } finally { await f.engine.shutdown(); }
      });
    });

    it.skipIf(process.platform === "win32")(`explicit Retry refreshes a saved pass as well as the opaque ${hookName}`, async () => {
      await fixture("built", async f => {
        try {
          f.setCheck("--pass");
          const hook = await externalHook(f, true);
          const passed = (await f.delivery()).checks!;
          const initialRuns = hook.runs();
          f.engine.takeItem(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          f.engine.fail(f.taskId, new Error("Delivery could not start"));
          hook.set(false);
          f.engine.setPoolPaused(true);
          await f.engine.retry(itemOf(f.engine.getState(), f.taskId, "stuck")!.id);
          const waiting = taskOf(f.engine.getState(), f.taskId).checks!;
          expect(waiting.results).toEqual(passed.results);
          expect(waiting.sha).toBeUndefined();
          expect(waiting.tree).toBeUndefined();
          f.engine.setPoolPaused(false);
          const failed = (await f.delivery()).checks!;
          expect(failed.results.at(-1)!.ok).toBe(false);
          expect(failed.results.at(-1)!.output).toContain("captured hook failure");
          expect(hook.runs()).toBe(initialRuns + 1);
          expect(f.runs()).toEqual(["passed", "passed"]);
        } finally { await f.engine.shutdown(); }
      });
    });

    it.skipIf(process.platform === "win32")(`notices identical ${hookName} launchers in different folders, before review and delivery`, async () => {
      await fixture("built", async f => {
        try {
          f.setCheck("--pass");
          const bad = join(f.root, "bad-hooks");
          const good = join(f.root, "good-hooks");
          for (const [folder, exit] of [[bad, 1], [good, 0]] as const) {
            mkdirSync(folder);
            writeFileSync(join(folder, hookName), '#!/bin/sh\nexec sh "$(dirname "$0")/check"\n');
            chmodSync(join(folder, hookName), 0o755);
            writeFileSync(join(folder, "check"), `echo "Hook beside the launcher: ${exit === 0 ? "passed" : "failed"}"\nexit ${exit}\n`);
          }
          expect(readFileSync(join(bad, hookName), "utf8")).toBe(readFileSync(join(good, hookName), "utf8"));
          await f.run(() => git(f.repo, "config", "core.hooksPath", bad));
          const failed = (await f.delivery()).checks!;
          expect(failed.results.at(-1)!.ok).toBe(false);
          expect(f.runs()).toEqual(["passed"]);

          await f.run(() => git(f.repo, "config", "core.hooksPath", good));
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Use the corrected hook folder");
          const passed = (await f.delivery()).checks!;
          expect(passed.tree).toBe(failed.tree);
          expect(passed.definition).not.toBe(failed.definition);
          expect(passed.results.at(-1)!.output).toContain("Hook beside the launcher: passed");
          expect(passed.results.every((run) => run.ok)).toBe(true);
          expect(f.runs()).toEqual(["passed", "passed"]);

          // Moving back after review must invalidate the pass at final delivery preparation too.
          await f.run(() => git(f.repo, "config", "core.hooksPath", bad));
          f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          const task = await f.delivery();
          expect(task.checks!.results.at(-1)!.output).toContain("Hook beside the launcher: failed");
          expect(f.runs()).toEqual(["passed", "passed", "passed"]);
          expect(await f.run(() => git(f.repo, "rev-parse", "HEAD"))).not.toBe(await f.run(() => git(task.worktree!, "rev-parse", "HEAD")));
        } finally {
          await f.engine.shutdown();
        }
      });
    });

    for (const originallyPassed of [false, true]) {
      it.skipIf(process.platform === "win32")(`reruns product checks before refreshing a saved ${hookName} ${originallyPassed ? "pass" : "failure"} with no recorded definition`, async () => {
        await fixture("built", async f => {
          try {
            f.setCheck("--pass");
            const hook = join(f.repo, ".git", "hooks", hookName);
            writeFileSync(hook, `#!/bin/sh\necho "Original hook"\nexit ${originallyPassed ? 0 : 1}\n`);
            chmodSync(hook, 0o755);
            const original = (await f.delivery()).checks!;
            expect(original.results.at(-1)!.ok).toBe(originallyPassed);
            writeFileSync(hook, `#!/bin/sh\necho "Changed hook"\nexit ${originallyPassed ? 1 : 0}\n`);
            await f.restart((state) => { delete state.tasks.find((task) => task.id === f.taskId)!.checks!.definition; });
            expect(taskOf(f.engine.getState(), f.taskId).checks!.definition).toBeUndefined();
            const item = itemOf(f.engine.getState(), f.taskId, "delivery")!;
            if (originallyPassed) {
              const missing = structuredClone(taskOf(f.engine.getState(), f.taskId).checks);
              expect(() => f.engine.approve(item.id)).toThrow("delivery has not been approved");
              expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.id).toBe(item.id);
              expect(taskOf(f.engine.getState(), f.taskId).checks).toEqual(missing);
              f.engine.rerunChecks(item.id);
            } else f.engine.requestChanges(item.id, "The hook has been corrected");
            const refreshed = (await f.delivery()).checks!;
            expect(refreshed.tree).toBe(original.tree);
            expect(refreshed.results.at(-1)!.ok).toBe(!originallyPassed);
            expect(refreshed.results.at(-1)!.output).toContain("Changed hook");
            expect(refreshed.definition).toMatch(/^[a-f0-9]{64}$/);
            expect(f.runs()).toEqual(["passed", "passed"]);

            // A failure remains evidence; a pass must revalidate the hook's opaque implementation.
            await f.restart();
            f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Check the saved result");
            const again = (await f.delivery()).checks!;
            if (originallyPassed) expect(again).toEqual(refreshed);
            else {
              expect(again.at).toBeGreaterThan(refreshed.at);
              expect(again.results[0]).toEqual(refreshed.results[0]);
              // A rerun keeps the outcome but creates a new diagnostic file with its own identity.
              expect(again.results.map(({ ms, logPath, logFileIdentity, startedAt, endedAt, source, ...run }) => run)).toEqual(refreshed.results.map(({ ms, logPath, logFileIdentity, startedAt, endedAt, source, ...run }) => run));
              expect(again.results.at(-1)!.logPath).not.toBe(refreshed.results.at(-1)!.logPath);
              expect(again.results.at(-1)!.logFileIdentity).not.toEqual(refreshed.results.at(-1)!.logFileIdentity);
              for (const run of [refreshed.results.at(-1)!, again.results.at(-1)!]) {
                const info = statSync(run.logPath!, { bigint: true });
                expect(run.logFileIdentity).toEqual({ device: info.dev.toString(), inode: info.ino.toString() });
              }
              expect(readFileSync(again.results.at(-1)!.logPath!, "utf8")).toBe(readFileSync(refreshed.results.at(-1)!.logPath!, "utf8"));
              expect(again.definition).toBe(refreshed.definition);
              expect(again.tree).toBe(refreshed.tree);
            }
            // The fresh definition now binds the product pass: later hook validation reuses it.
            expect(f.runs()).toEqual(["passed", "passed"]);
          } finally {
            await f.engine.shutdown();
          }
        }, true, { planner: "short" }, originallyPassed ? undefined : `Legacy ${hookName} failure`);
      });
    }

    it.skipIf(process.platform === "win32")(`keeps an older failed suite while refreshing ${hookName}, until a real fix`, async () => {
      await fixture("built", async f => {
        try {
          const hook = join(f.repo, ".git", "hooks", hookName);
          writeFileSync(hook, '#!/bin/sh\necho "Old hook failed"\nexit 1\n');
          chmodSync(hook, 0o755);
          await f.delivery();
          expect(f.runs()).toEqual(["failed"]);
          writeFileSync(hook, '#!/bin/sh\necho "Corrected hook passed"\n');
          await f.restart((state) => { delete state.tasks.find((task) => task.id === f.taskId)!.checks!.definition; });
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "The hook has been corrected");
          const failed = await f.delivery();
          expect(f.runs()).toEqual(["failed"]);
          expect(failed.checks!.results[0]!.output).toContain("captured failure");
          expect(failed.checks!.results[0]!.ok).toBe(false);
          expect(failed.checks!.results.at(-1)!.output).toContain("Corrected hook passed");
          expect(failed.checks!.results.at(-1)!.ok).toBe(true);
          expect(failed.checks!.definition).toMatch(/^[a-f0-9]{64}$/);

          f.agents.scenario({ planner: "short", fixes: "change" });
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Fix the failed product check");
          const fixed = await f.delivery();
          expect(f.runs()).toEqual(["failed", "passed"]);
          expect(fixed.checks!.results.every((run) => run.ok)).toBe(true);
        } finally {
          await f.engine.shutdown();
        }
      });
    });
  }
});
