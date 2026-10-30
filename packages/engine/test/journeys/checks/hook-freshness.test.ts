
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";


import { checkWorkflowFixtures, readWorktreeCommit, type CheckWorkflow } from "../../fixtures/check-workflow.js";
import { itemOf, taskOf, until } from "../../support.js";

function setLocalHooksPath(repo: string, folder: string): void {
  const cfgPath = join(repo, ".git", "config");
  const stripped = readFileSync(cfgPath, "utf8").replace(/^\s*hooksPath\s*=.*(?:\r?\n|$)/gim, "");
  const next = /^\[core\]\r?\n/im.test(stripped)
    ? stripped.replace(/^\[core\]\r?\n/im, (header) => `${header}\thooksPath = ${folder}\n`)
    : `${stripped}\n[core]\n\thooksPath = ${folder}\n`;
  writeFileSync(cfgPath, next);
}

const workflows = checkWorkflowFixtures();
afterAll(() => workflows.close());
const fixture = <T>(entry: Parameters<typeof workflows.use>[0], body: (fixture: CheckWorkflow) => Promise<T>) =>
  workflows.use(entry, body, true, { planner: "short" }, { acceptedBuilds: true, acceptedReviews: true });


describe.concurrent("failed checks are evidence until something changes", () => {
it.skipIf(process.platform === "win32")("checks a corrected commit title and changed local hook even when the code stays the same", async () => {
    await fixture("exhausted-repairs", async f => {
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
        expect(readWorktreeCommit(f.repo).message.split("\n")[0]).toBe("Fix: Add a greeting");
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
      setLocalHooksPath(f.repo, folder);
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

    // Explicit Retry of a saved pass is exercised directly in contracts/checks/hook-retry.

    it.skipIf(process.platform === "win32")(`notices identical ${hookName} launchers in different folders, before review and delivery`, async () => {
      await fixture("exhausted-repairs", async f => {
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
          setLocalHooksPath(f.repo, bad);
          const failed = (await f.delivery()).checks!;
          expect(failed.results.at(-1)!.ok).toBe(false);
          expect(f.runs()).toEqual(["passed"]);

          setLocalHooksPath(f.repo, good);
          f.engine.requestChanges(itemOf(f.engine.getState(), f.taskId, "delivery")!.id, "Use the corrected hook folder");
          const passed = (await f.delivery()).checks!;
          expect(passed.tree).toBe(failed.tree);
          expect(passed.definition).not.toBe(failed.definition);
          expect(passed.results.at(-1)!.output).toContain("Hook beside the launcher: passed");
          expect(passed.results.every((run) => run.ok)).toBe(true);
          expect(f.runs()).toEqual(["passed", "passed"]);

          // Moving back after review must invalidate the pass at final delivery preparation too.
          setLocalHooksPath(f.repo, bad);
          f.engine.approve(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
          const task = await f.delivery();
          expect(task.checks!.results.at(-1)!.output).toContain("Hook beside the launcher: failed");
          expect(f.runs()).toEqual(["passed", "passed", "passed"]);
          expect(readWorktreeCommit(f.repo).sha).not.toBe(readWorktreeCommit(task.worktree!).sha);
        } finally {
          await f.engine.shutdown();
        }
      });
    });

    // Persisted missing-definition cases exercise ProductChecks directly in contracts/checks/legacy-hook-evidence.

    it.skipIf(process.platform === "win32")(`keeps an older failed suite while refreshing ${hookName}, until a real fix`, async () => {
      await fixture("exhausted-repairs", async f => {
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
