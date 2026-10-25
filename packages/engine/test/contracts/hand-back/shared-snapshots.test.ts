import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { git, removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("retains all hand-back snapshot anchors after a partial advance, then checks both products on retry", async () => {
    const { engine, task } = await fixture("partial-shared-handback", { git: ["first","second"] });
    const anchors: Record<string, { path: string; head: string }> = {};
    for (const work of task.repositories!) {
      const root = work.worktree!, head = await git(root, "rev-parse", "HEAD"), copy = join(engine.dataDir, work.productId + "-snapshot");
      work.branch = "main"; work.baseSha = head;
      work.source = { product: { ...engine.s.products.find(product => product.id === work.productId)!, path: root }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "local/fixture", branch: "main" }, confirmed: true };
      work.checks = { current: true, at: 1, tree: await git(root, "rev-parse", "HEAD^{tree}"), results: [] };
      await gitOps.addCopy(root, copy, head);
      writeFileSync(join(copy, "hand-edited.txt"), work.productId + " edit\n");
      anchors[work.productId] = { path: copy, head };
    }
    task.driving = { roleId: "builder", profileId: "sol-high", toolId: "codex", head: anchors.first!.head, since: Date.now(), repositoryCopies: structuredClone(anchors) };
    const move = gitOps.moveTo;
    let fail = true;
    const moves = spyOn(gitOps, "moveTo").mockImplementation(async (path, sha) => {
      if (path === task.repositories![1]!.worktree && fail) throw new Error("Second product could not advance");
      return move(path, sha);
    });
    const start = engine.startDriver; engine.startDriver = () => {};
    try {
      await expectRejection(engine.handBack(task.id, "Keep the edits", true), "Second product could not advance");
      expect(task.driving!.repositoryCopies).toEqual(anchors);
      expect(existsSync(join(task.repositories![0]!.worktree!, "hand-edited.txt"))).toBe(true);
      expect(task.repositories![0]!.checks!.current).toBe(false);
      fail = false;
      await engine.handBack(task.id, "Keep the edits", true);
      expect(task.driving).toBeUndefined();
      for (const work of task.repositories!) {
        expect(readFileSync(join(work.worktree!, "hand-edited.txt"), "utf8")).toBe(work.productId + " edit\n");
        expect(work.tamper?.sha).toBe(await git(work.worktree!, "rev-parse", "HEAD"));
        expect(work.checks!.current).toBe(false);
      }
    } finally { moves.mockRestore(); engine.startDriver = start; await engine.shutdown(); }
  });

  it("inspects hand changes across products concurrently and records every result in product order", async () => {
    const { engine, task } = await fixture("hand-change-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    const checks: { path: string; resolve: (problems: string[]) => void }[] = [], heads: { path: string; resolve: (sha: string) => void }[] = [];
    const check = spyOn(gitOps, "tamperCheck").mockImplementation((path) => new Promise((resolve) => checks.push({ path, resolve })));
    const head = spyOn(gitOps, "head").mockImplementation((path) => new Promise((resolve) => heads.push({ path, resolve })));
    let pending: Promise<void> | undefined;
    try {
      task.plan = { rationale: "Review hand changes", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] }] };
      task.stageIndex = 0;
      const products = ["second", "first"], paths = products.map((id) => executionFor(task, id).work.worktree!);
      pending = engine["takeover"]["reviewHandChanges"](task, products);
      expect(checks.map((read) => read.path)).toEqual(paths);
      expect(heads.map((read) => read.path)).toEqual(paths);
      checks[1]!.resolve(["A test was removed"]); heads[1]!.resolve("a".repeat(40));
      await Promise.resolve();
      expect(task.findings).toEqual([]);
      checks[0]!.resolve(["A test was skipped"]); heads[0]!.resolve("b".repeat(40));
      await pending;
      expect(task.findings.map((finding) => [finding.text, finding.productIds])).toEqual([["A test was skipped", ["second"]], ["A test was removed", ["first"]]]);
      expect(executionFor(task, "first").work.tamper?.sha).toBe("a".repeat(40));
      expect(executionFor(task, "second").work.tamper?.sha).toBe("b".repeat(40));
      expect(task.handChanges).toBe(true);
      expect(task.rereview).toBe("review");
    } finally {
      for (const read of checks) read.resolve([]); for (const read of heads) read.resolve("a".repeat(40));
      await pending?.catch(() => {}); check.mockRestore(); head.mockRestore(); await engine.shutdown();
    }
  });
});
