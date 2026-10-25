import { afterAll, expect, it } from "bun:test";
import { beginAgentStep, JOURNEY_WORDS, type Stage, type DeepMutable } from "@petrina/core";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Engine } from "../../engine.js";
import { contentTree } from "@petrina/repositories/git";
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
for (const [change, updating] of [["committed", false], ["empty-commit", false], ["uncommitted", false], ["existing", false], ["empty-commit", true], ["committed", true]] as const) it(`compares actual Builder contents after a ${change} return (updating=${updating})`, async () => {
  const root = tempDir("petrina-builder-return-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null } });
  engine.setPoolPaused(true);
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "Investigate a failed check", backlog: true }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    scope.work.checks = { at: Date.now(), tree: await git(repo, "rev-parse", "HEAD^{tree}"), results: [{ name: "Tests", command: "tests", ok: false, ms: 1, output: "Original failure" }] };
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
    const updates: Pick<Updates, "message" | "fold" | "reopen" | "patch"> = { message: () => "Return", fold: async () => undefined, reopen: async () => undefined, patch: unexpected };
    const learnings: Pick<Learnings, "note"> = { note: async () => {} };
    const work = new Work(engine, turns, context, guide, updates, learnings, engine["checks"]);
    await work.runDo(scope, stage, new AbortController().signal);
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
  } finally { await engine.shutdown(); }
});
