import { expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { git } from "../../fixtures.js";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";

it("shares a fold's actual commit observation and skips only directly proven unchanged-source ancestry", async () => {
  const observed = await withRepositoryRecords("fold-observations", { git: ["first"] }, async ({ engine, task, run }) => run(async () => {
    const scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
    const clone = product.path!, base = await git(clone, "rev-parse", "HEAD"), copy = join(engine.dataDir, "fold-copy");
    await git(clone, "worktree", "add", "-q", "-b", "fold-task", copy, base);
    scope.work.worktree = copy; scope.work.baseSha = base; scope.work.base = base; scope.work.branch = "fold-task";
    scope.work.report = { title: "Task title", summary: "The task's actual change", changes: [] };
    writeFileSync(join(copy, "feature.txt"), "First task change\n");
    await git(copy, "add", "."); await git(copy, "commit", "-qm", "The initial task commit");
    const native = Bun.spawn;
    const calls: string[] = [];
    const watch = spyOn(Bun, "spawn");
    let folded: Awaited<ReturnType<typeof engine["updates"]["fold"]>>;
    try {
      watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        if (args[0][0] === "git" && args[1]?.cwd === copy) calls.push(args[0].includes("merge-base") ? "merge-base" : args[0].includes("show") ? "show" : "other");
        return Reflect.apply(native, Bun, args);
      }) as typeof Bun.spawn);
      folded = await engine["updates"].fold(scope);
      const firstShows = calls.filter(call => call === "show").length;
      const firstAncestry = calls.filter(call => call === "merge-base").length;
      expect(folded!.fork).toBe(base);
      expect(folded!.version).toEqual({ head: await git(copy, "rev-parse", "HEAD"), tree: await git(copy, "rev-parse", "HEAD^{tree}") });
      expect(scope.work.savedVersion).toEqual({ commit: folded!.version.head, tree: folded!.version.tree });
      // A new mutation is a new operation; its multi-commit ancestry still uses the real history query.
      writeFileSync(join(copy, "later.txt"), "Later task change\n"); await git(copy, "add", "."); await git(copy, "commit", "-qm", "Another actual commit");
      const beforeHistory = calls.filter(call => call === "merge-base").length;
      const later = await engine["updates"].fold(scope);
      expect(calls.filter(call => call === "merge-base").length).toBeGreaterThan(beforeHistory);
      expect(later!.version.head).not.toBe(folded!.version.head); expect(later!.version.tree).not.toBe(folded!.version.tree);
      expect(await git(copy, "show", "-s", "--format=%P", "HEAD")).toBe(base);
      writeFileSync(join(clone, "main.txt"), "Independent source change\n"); await git(clone, "add", "."); await git(clone, "commit", "-qm", "Main moved");
      const beforeMoved = calls.filter(call => call === "merge-base").length;
      const moved = await engine["updates"].fold(scope);
      expect(calls.filter(call => call === "merge-base").length).toBeGreaterThan(beforeMoved);
      expect(moved!.fork).toBe(base); expect(moved!.version).toEqual(later!.version);
      expect(await git(copy, "show", "HEAD:later.txt")).toBe("Later task change");
      return { firstShows, firstAncestry };
    } finally { watch.mockRestore(); }
  }));
  // Compare counts after the actual Engine, Git work and root cleanup have all settled.
  expect(observed).toEqual({ firstShows: 1, firstAncestry: 0 });
});
