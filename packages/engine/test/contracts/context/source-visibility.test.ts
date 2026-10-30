import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "../../../src/context.js";
import type { GuideKeeper } from "../../../src/guide-keeper.js";
import * as gitOps from "@petrina/repositories/git";
import { currentSourcePointers } from "@petrina/repositories/source-pointers";
import { createProductRepository } from "@petrina/test-support/repositories";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


it("carries only bounded current source locations to design or a first builder, never independent reviewers", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-source-pointers-"));
    const engine = owner.open(join(root, "data"), { usageCommands: { codex: null, grok: null }, toolProbe: privateAgentToolProbe() });
    try {
      await owner.run(engine, async () => {
        engine.setPoolPaused(true);
        const { path: copy, initialSha: revision } = await createProductRepository(root, { origin: "none" });
        await engine.waitUntilReady(); owner.check(); engine.stopRequested.signal.throwIfAborted();
        const productId = installPreparedProduct(engine, privateCloneProduct(copy));
        const id = engine.addTask({ productId, title: "Choose the design independently", backlog: true });
        const task = engine.task(id)!;
        executionFor(task).work.worktree = copy;
        const pointer = { productId, revision, path: "README.md" };
        task.sourcePointers = [pointer, pointer, { ...pointer, revision: "f".repeat(40) }, { ...pointer, path: "absent.md" }, { ...pointer, productId: "another-product" }];
        expect(await currentSourcePointers(repositoryView(executionFor(task)), task.sourcePointers)).toEqual([pointer]);
        const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
        for (const role of ["architect", "builder"]) {
          const section = (await new Context(engine, guide).sectionsFor(executionFor(task), role)).find((entry) => entry.title.startsWith("Previously inspected"))!;
          expect(section.body).toContain(`${productId}: README.md (source version ${revision})`);
          expect(section.body).toContain("selection can steer attention");
          expect(section.body).toContain("no recommendations or extra requirements");
          expect(section.body.length).toBeLessThan(700);
        }
        for (const role of ["code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
          expect((await new Context(engine, guide).sectionsFor(executionFor(task), role)).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
        }
        task.fixing = true;
        expect((await new Context(engine, guide).sectionsFor(executionFor(task), "builder")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
        task.fixing = false;
        task.plan = { stages: [{ id: "design", kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"] }], rationale: "Design first", plannerProfileId: "opus-high" };
        task.brief = { summary: "Choose independently", forUsers: [], areas: [], risks: [], acceptance: [] };
        expect((await new Context(engine, guide).sectionsFor(executionFor(task), "builder")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
        task.brief.sourcePointers = [pointer];
        task.sourcePointers = [];
        for (const role of ["architect", "builder"]) {
          expect((await new Context(engine, guide).sectionsFor(executionFor(task), role)).find((entry) => entry.title.startsWith("Previously inspected"))?.body).toContain("README.md");
        }
        expect((await new Context(engine, guide).sectionsFor(executionFor(task), "design-reviewer")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
        engine.commitNow();
        expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.sourcePointers).toEqual(task.sourcePointers);
        expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.brief!.sourcePointers).toEqual([pointer]);
        writeFileSync(join(copy, "VERSION"), "2.0.0\n");
        await gitOps.commitChanges(copy, "A different source version");
        expect(await currentSourcePointers(repositoryView(executionFor(task)), [pointer])).toEqual([]);

      });
    } finally { await owner.stop(engine);  }

  });
});
