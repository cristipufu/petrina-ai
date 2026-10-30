import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { instructionAgents } from "../../fixtures/instruction-agents.js";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { createProductRepository, waitFor } from "../../fixtures.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { preparedInstructionTask } from "../../fixtures/prepared-instructions.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());

describe("lessons agents pass on", () => {
  it("are offered at the delivery check once each, and the ones ticked join AGENTS.md with the next delivery", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-lessons-"));

      const agents = instructionAgents({ learnings: true });
      const engine = installSharedWorkflowFastPaths(owner.open(join(root, "data"), agents), {
        skipDriverPrepare: true,
        skipUpToDate: true,
        skipPrepareChecks: true,
        skipReviewCopies: true,
        skipReviewInputDiffs: true,
        fastCheckCapture: true,
        fastCleanup: true,
      });
      try {
        await owner.run(engine, async () => {
          const repository = await createProductRepository(root, { origin: "none" }), repo = repository.path;
          owner.check();
          const productId = installPreparedProduct(engine, privateCloneProduct(repo));
          engine.setProductDelivery(productId, "local", true);
          const offers: { body?: string; detail?: string }[] = [];
          const ship = async (title: string, initial?: typeof repository) => {
            const taskId = await preparedInstructionTask(engine, { productId, title, description: "[no-check]" }, agents, { learnings: true }, { entry: "builder", checks: "none", ...(initial ? { initial } : {}) }, owner.check);
            return waitFor(() => {
              owner.check();
              const state = engine.getState();
              for (const item of state.inbox) {
                if (item.kind === "learnings") {
                  offers.push(item);
                  // The coordinator ticks only the second.
                  engine.addLessons(item.id, [1]);
                }
                if (item.taskId !== taskId) continue;
                if (item.kind === "plan" || item.kind === "delivery") engine.approve(item.id);
                else if (item.kind === "permission") engine.allow(item.id, "once");
                else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
              }
              const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
              if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
              return found?.state === "done" && found;
            }, "the work to ship", 90_000);
          };
          const first = await ship("Add a greeting", repository);
          // One offer, with each lesson once: the reviewers' copy of the builder's lesson is the same lesson.
          expect(offers).toHaveLength(1);
          expect(offers[0]!.body).toBe("- Run the tests with bun test: they take a second.\n- Greetings live at the repository root.");
          expect(offers[0]!.detail).toContain("Claude Code and Codex both read that file by themselves");
          expect(first.timeline.map((entry) => entry.text)).toContain("You added a lesson to AGENTS.md");
          expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);

          // The next delivery carries them, in its one commit, and lessons AGENTS.md has are not offered again.
          await ship("Add a farewell");
          expect(readFileSync(join(repo, "AGENTS.md"), "utf8").replace(/\r?\n$/, "")).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Greetings live at the repository root.");
          expect(readWorktreeCommit(repo)?.body.split(/\r?\n/)[0]).toBe("Add a farewell");
          expect(offers).toHaveLength(1);

        });
      } finally {

        await owner.stop(engine);

      }

    });
  });
});

describe("a lesson AGENTS.md gained in the meantime", () => {
  it("is not offered: the coordinator, or another task, got there first", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-lessons-known-"));
      const hold = join(root, "hold-builder");
      writeFileSync(hold, "");

      const script = { learnings: true, hold: { title: "Add a greeting", file: hold, role: "builder" } } as const;
      const agents = instructionAgents(script);
      const engine = installSharedWorkflowFastPaths(owner.open(join(root, "data"), agents), {
        skipDriverPrepare: true,
        skipUpToDate: true,
        skipPrepareChecks: true,
        skipReviewCopies: true,
        skipReviewInputDiffs: true,
        fastCheckCapture: true,
        fastCleanup: true,
      });
      try {
        await owner.run(engine, async () => {
          const repository = await createProductRepository(root, { origin: "none" }), repo = repository.path;
          owner.check();
          const productId = installPreparedProduct(engine, privateCloneProduct(repo));
          engine.setProductDelivery(productId, "local", true);
          const taskId = await preparedInstructionTask(engine, { productId, title: "Add a greeting", description: "[no-check]" }, agents, script, { entry: "builder", checks: "none", initial: repository }, owner.check);
          let written = false;
          const offers: { body?: string }[] = [];
          const task = await waitFor(async () => {
            owner.check();
            let state = engine.getState();
            let found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
            // While the builder works on its branch, main gains the second lesson by the coordinator's own hand.
            if (!written && existsSync(`${hold}.reached`) && found?.timeline.some((entry) => entry.text === "Builder started")) {
              writeFileSync(join(repo, "AGENTS.md"), "## Learnings\n\n- Greetings live at the repository root.\n");
              await gitOps.commitChanges(repo, "Note where greetings live"); owner.check();
              rmSync(hold, { force: true });
              written = true;
              // Answer what the engine shows now, not what it showed before the commit.
              state = engine.getState();
              found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
            }
            for (const item of state.inbox) {
              if (item.taskId !== taskId) continue;
              if (item.kind === "learnings") {
                offers.push(item);
                engine.decline(item.id);
              } else if (item.kind === "plan" || item.kind === "delivery") engine.approve(item.id);
              else if (item.kind === "permission") engine.allow(item.id, "once");
              else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
            }
            if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
            return found?.state === "done" && found;
          }, "the work to ship", 120_000);
          expect(written).toBe(true);
          // The work was brought onto the new main before the delivery check, so the lesson main has by now stays out.
          expect(task.timeline.map((entry) => entry.text)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
          expect(offers).toHaveLength(1);
          expect(offers[0]!.body).toBe("- Run the tests with bun test: they take a second.");

        });
      } finally {
        rmSync(hold, { force: true });
        await owner.stop(engine);

      }

    });
  });
});
