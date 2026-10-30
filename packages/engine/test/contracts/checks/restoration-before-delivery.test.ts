import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as gitOps from "@petrina/repositories/git";
import { git } from "../../fixtures.js";
import type { Task } from "@petrina/core";
import { preparedCheckedLanding } from "../../fixtures/branch-boundaries.js";

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("checks only look", () => {
  it("puts back whatever a check changes in files git tracks, so nothing unreviewed ships", async () => {
    const f = await preparedCheckedLanding({ check: "tracked-write" });
    try {
      const task = await f.verifyAndLand(), repo = f.repo;
      expect(lines(task)).toContain("A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
      expect(await git(repo, "ls-tree", "--name-only", "main")).toContain("README.md");
      expect(await git(repo, "ls-tree", "--name-only", "main")).not.toContain("README.txt");
      expect(f.scope.work.confirmedDelivery!.sha).toBe((await gitOps.revParse(repo, "main"))!);
      expect(f.scope.work.confirmedDelivery!.sha).not.toBe(f.before);
      expect(task.checks!.environment).toBeDefined();
    } finally { await f.close(); }
  });

  it("takes back a commit a check makes, so nothing the coordinator did not approve ships", async () => {
    const f = await preparedCheckedLanding({ check: "unapproved-commit" });
    try {
      const task = await f.verifyAndLand(), repo = f.repo, before = f.before;
      expect(lines(task)).toContain("A check made a commit, so Petrina put the work back as it was: checks only look, and fixes come from the builder");
      expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
      expect(f.scope.work.confirmedDelivery!.sha).toBe((await gitOps.revParse(repo, "main"))!);
      expect(f.scope.work.confirmedDelivery!.sha).not.toBe(before);
      expect(task.checks!.results[0]!.execution).toMatchObject({ started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof" });
    } finally { await f.close(); }
  });
});

describe.concurrent.skipIf(process.platform === "win32")("the repository's own commit hooks", () => {
  it("runs a commit-msg hook on the task's one commit message, with the builder's title, and undoes what it changes", async () => {
    const check = `echo "Checking the commit title"
echo "changed by a hook" >> README.md
head -1 "$1" | grep -qE '^(feat|fix|chore): ' || { echo "commit-msg: use a conventional title" >&2; exit 1; }`;
    const f = await preparedCheckedLanding({ check: "commit-message", builderTitle: "feat: add a greeting", hook: check });
    try {
      const task = await f.verifyAndLand(), repo = f.repo, before = f.before;
      expect(task.checks?.results.find(run => run.name === "Commit message hook")).toMatchObject({ ok: true, command: "git hook run commit-msg" });
      const run = task.checks!.results.find(run => run.name === "Commit message hook")!;
      expect(readFileSync(run.logPath!, "utf8")).toContain("Checking the commit title");
      expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("feat: add a greeting");
      expect((await gitOps.fileAt(repo, "main", "README.md"))?.trim()).toBe("# Demo");
      expect(task.report!.title).toBe("feat: add a greeting");
      expect(task.journey!.filter(step => step.roleId === "builder").flatMap(step => step.agentResults ?? [])).toHaveLength(1);
      expect(f.scope.work.confirmedDelivery!.sha).toBe((await gitOps.revParse(repo, "main"))!);
    } finally { await f.close(); }
  });
});
