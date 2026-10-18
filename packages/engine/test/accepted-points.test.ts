import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcceptedPoints } from "../src/accepted-points.js";
import { Engine } from "../src/engine.js";
import { Learnings } from "../src/learnings.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("retires incorporated lessons and guide points after restart, preserving unpublished points and later coordinator edits", async () => {
  const root = tempDir("petrina-accepted-points-");
  roots.push(root);
  let engine = new Engine(join(root, "data"), { codexCommand: null });
  try {
    engine.setPoolPaused(true);
    const repo = makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "An old accepted lesson" }))!;
    engine.cancel(task.id);
    const incorporated = "Run the package test command.";
    const pending = "Keep the focused check's full diagnostic.";
    const incorporatedRule = "Review every product's changed code.";
    const pendingRule = "Verify each product's check evidence.";
    writeFileSync(join(repo, "AGENTS.md"), `- ${incorporated}\n`);
    writeFileSync(join(repo, "REVIEW.md"), `- ${incorporatedRule}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "Incorporate approved instructions");
    git(repo, "switch", "-q", "-c", "unpublished");
    writeFileSync(join(repo, "AGENTS.md"), `- ${incorporated}\n- ${pending}\n`);
    writeFileSync(join(repo, "REVIEW.md"), `- ${incorporatedRule}\n- ${pendingRule}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "Instructions still on another branch");
    git(repo, "switch", "-q", "main");
    const product = engine.productOf(task)!;
    product.learnings = [incorporated, pending].map((text) => ({ text, at: 0, fromTask: task.id, writtenOn: task.id }));
    product.reviewGuide = [incorporatedRule, pendingRule].map((text) => ({ text, at: 0, fromTask: task.id, writtenOn: task.id }));
    await engine.shutdown();
    engine = new Engine(join(root, "data"), { codexCommand: null });
    await waitFor(() => {
      const saved = engine.getState().products.find((entry) => entry.id === productId)!;
      return saved.learnings?.length === 1 && saved.reviewGuide?.length === 1;
    }, "incorporated points to leave the pending queues");
    const saved = engine.getState().products.find((entry) => entry.id === productId)!;
    expect(saved.learnings?.map((line) => line.text)).toEqual([pending]);
    expect(saved.reviewGuide?.map((line) => line.text)).toEqual([pendingRule]);
    writeFileSync(join(repo, "AGENTS.md"), "# Corrected guidance\n");
    writeFileSync(join(repo, "REVIEW.md"), "# Corrected review guide\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "Coordinator removes obsolete instructions");
    const next = engine.task(engine.addTask({ productId, title: "A later delivery" }))!;
    next.worktree = repo;
    await new Learnings(engine).write(next);
    const file = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(file).toContain(pending);
    expect(file).not.toContain(incorporated);
    await engine.shutdown();
    engine = new Engine(join(root, "data"), { codexCommand: null });
    await new AcceptedPoints(engine).sweep();
    expect(engine.getState().products.find((entry) => entry.id === productId)!.learnings).toEqual([]);
    expect(readFileSync(join(repo, "REVIEW.md"), "utf8")).toBe("# Corrected review guide\n");
  } finally { await engine.shutdown(); }
});

it("keeps pending instructions when the default branch cannot be read", async () => {
  const root = tempDir("petrina-accepted-unavailable-");
  roots.push(root);
  const engine = new Engine(join(root, "data"), { codexCommand: null });
  try {
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(makeProduct(root));
    const task = engine.task(engine.addTask({ productId, title: "Keep unpublished guidance" }))!;
    const product = engine.productOf(task)!;
    const pending = [{ text: "Keep this accepted instruction.", at: 0, fromTask: task.id }];
    product.learnings = pending;
    product.reviewGuide = pending;
    product.defaultBranch = "missing-branch";
    await new AcceptedPoints(engine).sweep();
    expect(product.learnings).toEqual(pending);
    expect(product.reviewGuide).toEqual(pending);
  } finally { await engine.shutdown(); }
});
