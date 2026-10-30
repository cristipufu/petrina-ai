import { afterAll, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { checkContext } from "../../fixtures/check-context.js";
import { writeGitProgram } from "@petrina/test-support/git-program";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

// Hook discovery, actual execution, saved evidence and diagnostic-file identity are the boundary.
// Coordinator decision commands and the complete delivery path retain separate native controls.
for (const hookName of ["pre-commit", "commit-msg"] as const) for (const originallyPassed of [false, true]) {
  it(`refreshes a persisted ${hookName} ${originallyPassed ? "pass" : "failure"} with no recorded definition`, () => cases.use("legacy-hook-evidence-", owner => checkContext(owner, async f => {
    f.setCheck("--pass");
    const hook = join(f.scope.work.worktree!, ".git", "hooks", hookName);
    writeGitProgram(hook, `echo "Original hook"\nexit ${originallyPassed ? 0 : 1}`);
    await f.check();
    const original = structuredClone(f.scope.work.checks!);
    expect(original.results.at(-1)!.ok).toBe(originallyPassed);
    writeGitProgram(hook, `echo "Changed hook"\nexit ${originallyPassed ? 1 : 0}`);
    delete f.scope.work.checks!.definition;
    await f.restart();
    expect(f.scope.work.checks!.definition).toBeUndefined();
    expect(f.scope.work.checks!.results).toEqual(original.results);
    expect((await owner.run(f.engine, () => f.engine["checks"].current(f.scope))).inputs.kind).not.toBe("matches");
    if (originallyPassed) {
      f.task.plan = { rationale: "The saved check decision", plannerProfileId: "sol-high", stages: [
        { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
      ] };
      f.task.stageIndex = 0;
      f.scope.work.checkedSha = original.sha;
      f.engine.gate(f.task, "delivery");
      const item = f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "delivery")!;
      const missing = structuredClone(f.scope.work.checks);
      expect(() => f.engine.approve(item.id)).toThrow("delivery has not been approved");
      expect(f.engine.s.inbox.find(entry => entry.id === item.id)?.id).toBe(item.id);
      expect(f.scope.work.checks).toEqual(missing);
      f.engine.rerunChecks(item.id);
      f.task.state = "running";
    }
    await f.check();
    const refreshed = structuredClone(f.scope.work.checks!);
    expect(refreshed.tree).toBe(original.tree);
    expect(refreshed.results.at(-1)!.ok).toBe(!originallyPassed);
    expect(refreshed.results.at(-1)!.output).toContain("Changed hook");
    expect(refreshed.definition).toMatch(/^[a-f0-9]{64}$/);
    expect(f.runs()).toEqual(["passed", "passed"]);

    await f.restart();
    await f.check();
    const again = f.scope.work.checks!;
    if (originallyPassed) expect(again).toEqual(refreshed);
    else {
      expect(again.at).toBeGreaterThan(refreshed.at);
      expect(again.results[0]).toEqual(refreshed.results[0]);
      const outcomes = (runs: typeof again.results) => runs.map(({ ms, logPath, logFileIdentity, startedAt, endedAt, source, ...run }) => run);
      expect(outcomes(again.results)).toEqual(outcomes(refreshed.results));
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
    expect(f.runs()).toEqual(["passed", "passed"]);
  })));
}
