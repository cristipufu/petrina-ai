import { afterAll, expect, it } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeGitProgram } from "@petrina/test-support/git-program";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { checkContext } from "../../fixtures/check-context.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

// Retry owns invalidation; ProductChecks owns the real command/hook rerun. The surrounding
// delivery, opaque failure and restart journey remains in journeys/checks/hook-freshness.
for (const hookName of ["pre-commit", "commit-msg"] as const) {
  it(`explicit Retry refreshes a saved pass as well as the opaque ${hookName}`, () => cases.use("hook-retry-", owner => checkContext(owner, async f => {
    f.setCheck("--pass");
    const folder = join(owner.root, "external-hooks"), launcher = join(folder, hookName);
    writeGitProgram(launcher, 'exec sh "$(dirname "$0")/implementation"');
    const set = (ok: boolean) => writeFileSync(join(folder, "implementation"), `dir=$(dirname "$0")\nprintf 'run\\n' >> "$dir/runs"\necho "External implementation: ${ok ? "passed" : "failed (captured hook failure)"}"\nexit ${ok ? 0 : 1}\n`);
    const runs = () => existsSync(join(folder, "runs")) ? readFileSync(join(folder, "runs"), "utf8").trim().split("\n").length : 0;
    appendFileSync(join(f.scope.work.worktree!, ".git", "config"), `\n[core]\n\thooksPath = ${JSON.stringify(folder)}\n`);
    owner.check();
    set(true);
    await f.check();
    owner.check();
    const passed = structuredClone(f.scope.work.checks!), initialRuns = runs();
    expect(passed.results.every(run => run.ok)).toBe(true);
    const original = readFileSync(launcher, "utf8");
    f.engine.fail(f.taskId, new Error("Delivery could not start"));
    set(false);
    expect(readFileSync(launcher, "utf8")).toBe(original);
    f.engine.setPoolPaused(true);
    const stuck = f.engine.s.inbox.find(item => item.taskId === f.taskId && item.kind === "stuck")!;
    await owner.run(f.engine, () => f.engine.retry(stuck.id));
    owner.check();
    const waiting = f.scope.work.checks!;
    expect(waiting.results).toEqual(passed.results);
    expect(waiting.sha).toBeUndefined();
    expect(waiting.tree).toBeUndefined();
    f.engine.setPoolPaused(false);
    f.task.state = "running";
    await f.check();
    const failed = f.scope.work.checks!;
    expect(failed.results.at(-1)!.ok).toBe(false);
    expect(failed.results.at(-1)!.output).toContain("captured hook failure");
    expect(runs()).toBe(initialRuns + 1);
    expect(f.runs()).toEqual(["passed", "passed"]);
  })));
}
