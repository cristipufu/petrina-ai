import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { afterAll, expect, it, spyOn } from "bun:test";
import { beginAgentStep, JOURNEY_WORDS, type Stage, type DeepMutable } from "@petrina/core";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Engine } from "../../engine.js";
import { contentTree } from "@petrina/repositories/git";
import * as gitOps from "@petrina/repositories/git";
import { expectRejection } from "@petrina/test-support/rejections";
import { Work } from "../../../src/work.js";
import { executionFor } from "@petrina/orchestrator";
import type { Turns } from "../../../src/turn.js";
import type { Context } from "../../../src/context.js";
import type { GuideKeeper } from "../../../src/guide-keeper.js";
import type { Updates } from "../../../src/update.js";
import type { Learnings } from "../../../src/learnings.js";
import { git, makeProduct, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
for (const [change, updating, folding] of [
  ["committed", false, "none"], ["empty-commit", false, "none"], ["uncommitted", false, "none"],
  ["existing", false, "none"], ["empty-commit", true, "none"], ["committed", true, "none"],
  ["committed", false, "observed"], ["committed", false, "malformed"],
] as const) it(`compares actual Builder contents after a ${change} return (updating=${updating})${folding === "none" ? "" : ` with ${folding} fold evidence`}`, async () => {
  const root = tempDir("petrina-builder-return-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null } });
  engine.setPoolPaused(true);
  let trees: ReturnType<typeof spyOn<typeof gitOps, "treeOf">> | undefined;
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "Investigate a failed check", backlog: true }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    if (folding !== "none") {
      scope.work.baseSha = await git(repo, "rev-parse", "HEAD");
      scope.work.base = "main"; scope.work.branch = "task";
      await git(repo, "checkout", "-qb", "task");
    }
    scope.work.checks = { ...(folding === "malformed" ? { current: true } : {}), at: Date.now(), tree: await git(repo, "rev-parse", "HEAD^{tree}"), results: [{ name: "Tests", command: "tests", ok: false, execution: completeCheckExecution(7), ms: 1, output: "Original failure" }] };
    task.findings = [{ id: "check", text: "Check failed: Tests (tests)", raisedBy: "petrina", confirmedBy: [], severity: "blocking", status: "open" }];
    // A renamed build-result role must receive exactly the same contract.
    const role = engine.role("builder")!;
    engine.s.roles.push({ ...role, id: "repairer", name: "Investigator" });
    const stage: DeepMutable<Stage> = { id: "build", title: "Build", kind: "do", roleId: "repairer", profileIds: ["sol-high"] };
    task.plan = { rationale: "Focused repair", plannerProfileId: "sol-high", stages: [stage] };
    task.stageIndex = 0; task.fixing = true;
    if (updating) scope.work.updating = { from: "main", onto: await git(repo, "rev-parse", "HEAD"), files: [] };
    beginAgentStep(task, stage.roleId, "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
    if (change === "existing") {
      writeFileSync(join(repo, "repair.txt"), "Existing task change\n");
      const staged = await git(repo, "write-tree"), status = await git(repo, "status", "--porcelain");
      expect(await contentTree(repo)).not.toBe(staged);
      expect(await git(repo, "write-tree")).toBe(staged);
      expect(await git(repo, "status", "--porcelain")).toBe(status);
    }
    const turns: Pick<Turns, "turn"> = { turn: async (_scope, _role, _profile, _sections, schema) => {
      if (change === "committed" || change === "uncommitted") writeFileSync(join(repo, "repair.txt"), "Actual repair\n");
      if (change === "committed") { await git(repo, "add", "repair.txt"); await git(repo, "commit", "-q", "-m", "Repair"); }
      if (change === "empty-commit") await git(repo, "commit", "-q", "--allow-empty", "-m", "Investigation only");
      return schema.parse({ summary: "Builder explanation", changes: [], answers: [{ id: "check", fixed: change !== "empty-commit", text: "Recorded Builder claim" }], learnings: [] });
    } };
    const unexpected = async (): Promise<never> => { throw new Error("The content comparison requested an unrelated effect"); };
    const context: Pick<Context, "sectionsFor"> = { sectionsFor: unexpected };
    const guide: Pick<GuideKeeper, "proposeGuideLine"> = { proposeGuideLine: unexpected };
    trees = spyOn(gitOps, "treeOf");
    let foldReads = -1, folded: Awaited<ReturnType<Updates["fold"]>>;
    const updates: Pick<Updates, "message" | "fold" | "reopen" | "patch"> = { message: () => "Return", fold: async owner => {
      folded = folding === "none" ? undefined : await engine["updates"].fold(owner);
      if (folding !== "none" && !folded) throw new Error("The native fold did not return its version");
      foldReads = trees!.mock.calls.length;
      return folding === "malformed" && folded ? { ...folded, version: { ...folded.version, tree: "" } } : folded;
    }, reopen: async () => undefined, patch: unexpected };
    const learnings: Pick<Learnings, "note"> = { note: async () => {} };
    const work = new Work(engine, turns, context, guide, updates, learnings, engine["checks"]);
    if (folding === "malformed") {
      await expectRejection(work.runDo(scope, stage, new AbortController().signal), "could not read the folded product version");
      expect(trees.mock.calls).toHaveLength(foldReads);
      expect(scope.work.checks!.current).not.toBe(true);
      expect(task.journey!.at(-1)!.buildVersions).toBeUndefined();
      return;
    }
    await work.runDo(scope, stage, new AbortController().signal);
    expect(trees.mock.calls).toHaveLength(foldReads + (folding === "none" ? 1 : 0));
    if (folded) {
      expect(folded.fork).toBe(scope.work.baseSha!);
      expect(folded.version).toEqual({ head: await git(repo, "rev-parse", "HEAD"), tree: await git(repo, "rev-parse", "HEAD^{tree}") });
      expect(task.journey!.at(-1)!.buildVersions).toEqual({ [productId]: folded.version.tree });
    }
    const returned = task.journey!.at(-1)!;
    expect(returned.builderReturn?.changed).toBe(change !== "empty-commit" && change !== "existing");
    const words = change === "empty-commit" ? "No code changes; checks still failing" : change === "existing" ? "No code changes; checks still failing; 1 fix claimed" : "Changes returned; 1 fix claimed";
    expect(returned.builderReturn!.outcome).toBe(words);
    if (updating) {
      expect(returned.outcome).toBe(JOURNEY_WORDS.broughtUpToDate);
      expect(task.timeline.some(entry => entry.text.startsWith("Brought up to date with main"))).toBe(true);
    } else { expect(returned.outcome).toBe(words); expect(returned.reason).toBe(words); }
    expect(task.findings[0]!.status).toBe("open");
    expect(returned.result?.findings?.[0]?.answer?.fixed).toBe(change !== "empty-commit");
  } finally { trees?.mockRestore(); await engine.shutdown(); }
});
