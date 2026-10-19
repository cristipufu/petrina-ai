import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "../src/context.js";
import { Engine } from "../src/engine.js";
import type { GuideKeeper } from "../src/guide-keeper.js";
import { SourcePointers } from "../src/roles.js";
import { currentSourcePointers } from "../src/source-pointers.js";
import { git, makeProduct, removeDir, tempDir } from "./support.js";

it("carries only bounded current source locations to design or a first builder, never independent reviewers", async () => {
  const root = tempDir("petrina-source-pointers-");
  const engine = new Engine(join(root, "data"), { codexCommand: null, grokCommand: null });
  try {
    engine.setPoolPaused(true);
    const copy = makeProduct(root);
    const productId = await engine.addProduct(copy);
    const id = engine.addTask({ productId, title: "Choose the design independently", backlog: true });
    const task = engine.task(id)!;
    task.worktree = copy;
    const revision = git(copy, "rev-parse", "HEAD");
    const pointer = { productId, revision, path: "README.md" };
    task.sourcePointers = [pointer, pointer, { ...pointer, revision: "f".repeat(40) }, { ...pointer, path: "absent.md" }, { ...pointer, productId: "another-product" }];
    expect(await currentSourcePointers(task, task.sourcePointers)).toEqual([pointer]);
    const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
    for (const role of ["architect", "builder"]) {
      const section = (await new Context(engine, guide).sectionsFor(task, role)).find((entry) => entry.title.startsWith("Previously inspected"))!;
      expect(section.body).toContain(`${productId}: README.md (source version ${revision})`);
      expect(section.body).toContain("selection can steer attention");
      expect(section.body).toContain("no recommendations or extra requirements");
      expect(section.body.length).toBeLessThan(700);
    }
    for (const role of ["code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
      expect((await new Context(engine, guide).sectionsFor(task, role)).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    }
    task.fixing = true;
    expect((await new Context(engine, guide).sectionsFor(task, "builder")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    engine.commitNow();
    expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.sourcePointers).toEqual(task.sourcePointers);
    writeFileSync(join(copy, "VERSION"), "2.0.0\n");
    git(copy, "add", "VERSION");
    git(copy, "commit", "-q", "-m", "A different source version");
    expect(await currentSourcePointers(task, [pointer])).toEqual([]);
  } finally { await engine.shutdown(); removeDir(root); }
});

it("accepts source references rather than research opinions, and bounds their size", () => {
  const pointer = { productId: "shop", revision: "a".repeat(40), path: "docs/design.md" };
  expect(SourcePointers.safeParse([pointer]).success).toBe(true);
  expect(SourcePointers.safeParse([{ ...pointer, recommendation: "Use my preferred design" }]).success).toBe(false);
  expect(SourcePointers.safeParse([{ ...pointer, path: "../other-product" }]).success).toBe(false);
  expect(SourcePointers.safeParse([{ ...pointer, revision: "main" }]).success).toBe(false);
  expect(SourcePointers.safeParse(Array(9).fill(pointer)).success).toBe(false);
});
