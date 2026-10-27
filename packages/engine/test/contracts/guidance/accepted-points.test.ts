import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcceptedPoints } from "../../../src/accepted-points.js";
import { Learnings } from "../../../src/learnings.js";
import { git, makeProduct, waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


it("retires incorporated lessons and guide points after restart, preserving unpublished points and later coordinator edits", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-accepted-points-"));

    let engine = owner.open(join(root, "data"), { usageCommands: { codex: null } });
    try {
      engine.setPoolPaused(true);
      const repo = await makeProduct(root);
      const productId = await engine.addProduct(repo);
      const beforeRule = await git(repo, "rev-parse", "HEAD");
      const task = engine.task(engine.addTask({ productId, title: "An old accepted lesson" }))!;
      engine.cancel(task.id);
      const incorporated = "Run the package test command.";
      const pending = "Keep the focused check's full diagnostic.";
      const incorporatedRule = "Review every product's changed code.";
      const pendingRule = "Verify each product's check evidence.";
      writeFileSync(join(repo, "AGENTS.md"), `- ${incorporated}\n`);
      writeFileSync(join(repo, "REVIEW.md"), `- ${incorporatedRule}\n`);
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "Incorporate approved instructions");
      const incorporatedCommit = await git(repo, "rev-parse", "HEAD");
      await git(repo, "switch", "-q", "-c", "unpublished");
      writeFileSync(join(repo, "AGENTS.md"), `- ${incorporated}\n- ${pending}\n`);
      writeFileSync(join(repo, "REVIEW.md"), `- ${incorporatedRule}\n- ${pendingRule}\n`);
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "Instructions still on another branch");
      await git(repo, "switch", "-q", "main");
      const product = engine.productOf(task)!;
      product.learnings = [incorporated, pending].map((text) => ({ text, at: 0, fromTask: task.id, writtenOn: task.id }));
      product.reviewGuide = [incorporatedRule, pendingRule].map((text) => ({ text, at: 0, fromTask: task.id, writtenOn: task.id }));
      await owner.stop(engine);
      engine = owner.open(join(root, "data"), { usageCommands: { codex: null } });
      await waitFor(() => {
        const saved = engine.getState().products.find((entry) => entry.id === productId)!;
        return saved.learnings?.length === 1 && saved.reviewGuide?.filter((line) => !line.incorporatedOn).length === 1;
      }, "incorporated points to leave the pending queues");
      const saved = engine.getState().products.find((entry) => entry.id === productId)!;
      expect(saved.learnings?.map((line) => line.text)).toEqual([pending]);
      expect(saved.reviewGuide?.map((line) => [line.text, line.incorporatedOn])).toEqual([[incorporatedRule, incorporatedCommit], [pendingRule, undefined]]);
      writeFileSync(join(repo, "AGENTS.md"), "# Corrected guidance\n");
      writeFileSync(join(repo, "REVIEW.md"), "# Corrected review guide\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "Coordinator removes obsolete instructions");
      const next = engine.task(engine.addTask({ productId, title: "A later delivery" }))!;
      executionFor(next).work.worktree = repo;
      executionFor(next).work.baseSha = await git(repo, "rev-parse", "HEAD");
      const older = { ...next, repository: { ...next.repository!, baseSha: beforeRule } };
      const incorporatedBase = { ...next, repository: { ...next.repository!, baseSha: incorporatedCommit } };
      const keeper = engine["guide"];
      expect(await keeper.pendingPoints(executionFor(older))).toEqual([incorporatedRule, pendingRule]);
      expect(await keeper.pendingPoints(executionFor(incorporatedBase))).toEqual([pendingRule]);
      expect(await keeper.pendingPoints(executionFor(next))).toEqual([pendingRule]);
      expect(await keeper.reviewGuide(executionFor(older))).toContain(incorporatedRule);
      expect(await keeper.reviewGuide(executionFor(next))).not.toContain(incorporatedRule);
      expect(await keeper.pendingPoints({ task: next, work: { ...executionFor(next).work, baseSha: "f".repeat(40) } })).toEqual([incorporatedRule, pendingRule]);
      await new Learnings(engine).write(executionFor(next));
      await keeper.writeGuide(executionFor(next));
      const file = readFileSync(join(repo, "AGENTS.md"), "utf8");
      expect(file).toContain(pending);
      expect(file).not.toContain(incorporated);
      await owner.stop(engine);
      engine = owner.open(join(root, "data"), { usageCommands: { codex: null } });
      await new AcceptedPoints(engine).sweep();
      expect(engine.getState().products.find((entry) => entry.id === productId)!.learnings).toEqual([]);
      const guide = readFileSync(join(repo, "REVIEW.md"), "utf8");
      expect(guide).toContain(pendingRule);
      expect(guide).not.toContain(incorporatedRule);
      // A fresh explicit approval can restore the rule, rather than being ignored as an old receipt.
      const currentTask = engine.task(next.id)!;
      engine.approve(engine.raise(currentTask, "guide", "Restore this rule?", false, { body: incorporatedRule }));
      const restored = engine.productOf(currentTask)!.reviewGuide!.find((line) => line.text === incorporatedRule)!;
      expect(restored.incorporatedOn).toBeUndefined();
      expect(restored.writtenOn).toBeUndefined();
      expect(restored.fromTask).toBe(next.id);
      expect(await engine["guide"].pendingPoints(executionFor(currentTask))).toContain(incorporatedRule);
      await engine["guide"].writeGuide(executionFor(currentTask));
      expect(readFileSync(join(repo, "REVIEW.md"), "utf8")).toContain(incorporatedRule);
    } finally { await owner.stop(engine); }

  });
});

it("keeps pending instructions when the default branch cannot be read", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-accepted-unavailable-"));

    const engine = owner.open(join(root, "data"), { usageCommands: { codex: null } });
    try {
      await owner.run(engine, async () => {
        engine.setPoolPaused(true);
        const productId = await engine.addProduct(await makeProduct(root));
        const task = engine.task(engine.addTask({ productId, title: "Keep unpublished guidance" }))!;
        const product = engine.productOf(task)!;
        const pending = [{ text: "Keep this accepted instruction.", at: 0, fromTask: task.id }];
        product.learnings = pending;
        product.reviewGuide = pending;
        product.defaultBranch = "missing-branch";
        await new AcceptedPoints(engine).sweep();
        expect(product.learnings).toEqual(pending);
        expect(product.reviewGuide).toEqual(pending);

      });
    } finally { await owner.stop(engine); }

  });
});
