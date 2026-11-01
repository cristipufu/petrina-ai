import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { Coordination } from "../../../src/coordination.js";
import { createProductRepository, waitFor } from "../../fixtures.js";
import { checkAgents } from "../../fixtures/check-agents.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { scriptedToolProbe } from "../../scripted-probes.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

describe("single-agent tasks and eager check discovery", () => {
  it("runs a deduplicated one-node Check finder task and isolates fallback check discovery from feature requests", async () => {
    return engineCases.use("petrina-direct-checks-", async (caseOwner) => {
      const root = caseOwner.root;
      const fakes = checkAgents();
      fakes.scenario({ planner: "short" });
      const agents = new ScriptedAgents((prompt, signal) =>
        prompt.result === "check-discovery"
          ? scriptedResult({
              summary: "Verified Git check on this machine.",
              checks: [{ name: "Git version", argv: ["git", "--version"], why: "Confirm Git works in the repository" }],
            })
          : fakes.respond(prompt, signal),
      );
      const engine = installSharedWorkflowFastPaths(
        caseOwner.open(join(root, "data"), {
          startAgentSession: agents.start,
          toolProbe: scriptedToolProbe({
            "claude-code": { status: "ready" },
            codex: { status: "ready" },
            grok: { status: "ready" },
            gh: { status: "not-installed" },
            git: { status: "ready" },
          }),
        }),
        {
          skipDriverPrepare: true,
          skipUpToDate: true,
          skipPrepareChecks: true,
          skipReviewCopies: true,
          skipReviewInputDiffs: true,
          fastCheckCapture: true,
          fastCleanup: true,
        },
      );

      try {
        const { path: repo } = await createProductRepository(root, { origin: "none" });
        const productId = await caseOwner.run(engine, async () => {
          await engine.waitUntilReady();
          caseOwner.check();
          return installPreparedProduct(engine, privateCloneProduct(repo));
        });
        engine.setProductDelivery(productId, "local", true);
        engine.setProductChecks(productId, [{ name: "Manual check", command: "git status --short" }]);
        const coordination = new Coordination(engine);

        // A backlog check-discovery task neither erases coordinator checks nor blocks eager discovery.
        const backlogDiscoveryId = engine.addTask({
          productId,
          title: "Saved backlog check discovery",
          backlog: true,
          direct: { roleId: "check-finder", profileId: "opus-high" },
        });
        expect(engine.getState().products.find((entry) => entry.id === productId)?.checksBy).toBe("coordinator");

        engine.setPoolPaused(true);
        const cancelledId = engine.discoverProductChecks(productId);
        expect(cancelledId).not.toBe(backlogDiscoveryId);
        engine.cancel(cancelledId);
        expect(engine.getState().products.find((entry) => entry.id === productId)?.checksBy).toBe("coordinator");
        expect(engine.getState().products.find((entry) => entry.id === productId)?.checks?.[0]?.name).toBe("Manual check");

        const firstReply = (await coordination.call("product.discover-checks", {
          productId,
          requestId: "discover-checks-1",
        })) as unknown as { taskId: string; reused: boolean };
        expect(firstReply.reused).toBe(false);

        const secondId = engine.discoverProductChecks(productId);
        expect(secondId).toBe(firstReply.taskId);
        const secondReply = (await coordination.call("product.discover-checks", {
          productId,
          requestId: "discover-checks-2",
        })) as unknown as Record<string, unknown>;
        expect(secondReply).toEqual({
          outcome: "completed",
          requestId: "discover-checks-2",
          productId,
          taskId: firstReply.taskId,
          reused: true,
        });

        engine.setPoolPaused(false);
        const finishedDiscovery = await waitFor(() => {
          const task = engine.taskDetails(firstReply.taskId);
          if (task?.state === "failed") throw new Error(`Check discovery failed: ${task.error}`);
          return task?.state === "done" ? task : undefined;
        }, "eager check discovery completion", 30_000);

        expect(finishedDiscovery.noProductChanges).toBe(true);
        expect(finishedDiscovery.statusLine).toBe("Completed · No product changes");
        expect(agents.received("plan")).toHaveLength(0);
        expect(agents.received("findings")).toHaveLength(0);
        expect(agents.received("check-discovery")).toHaveLength(1);
        expect(agents.received("check-discovery")[0]!.text).toContain("keep names and \"why\" reasons about the whole product");

        const product = engine.getState().products.find((entry) => entry.id === productId)!;
        expect(product.checksBy).toBe("finder");
        expect(product.checks).toEqual([
          { name: "Git version", argv: ["git", "--version"], why: "Confirm Git works in the repository" },
        ]);

        // When build files later change on main, fallback check discovery stays product-scoped and never sees feature titles.
        writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "true" } }, null, 2));
        await gitOps.commitChanges(repo, "Add package.json on main");

        const settle = (state: State) => {
          for (const item of state.inbox) {
            if (item.kind === "plan") engine.approve(item.id);
          }
        };
        const featureId = engine.addTask({
          productId,
          title: "Secret seasonal coupon banner",
          description: "Show WINTER99 on the cart header.",
        });
        await waitFor(() => {
          const state = engine.getState();
          settle(state);
          const task = engine.taskDetails(featureId);
          if (task?.state === "failed") throw new Error(`Feature task failed: ${task.error}`);
          return state.inbox.find((item) => item.taskId === featureId && item.kind === "delivery");
        }, "feature task delivery gate after fallback check discovery", 60_000);

        expect(agents.received("check-discovery")).toHaveLength(2);
        const fallbackPrompt = agents.received("check-discovery")[1]!.text;
        expect(fallbackPrompt).toContain("# Product check discovery:");
        expect(fallbackPrompt).not.toContain("Secret seasonal coupon banner");
        expect(fallbackPrompt).not.toContain("WINTER99");
      } finally {
        await caseOwner.stop(engine);
      }
    });
  });

  it("executes single-agent read-only tasks and single-agent editing tasks with or without file changes", async () => {
    return engineCases.use("petrina-direct-runs-", async (caseOwner) => {
      const root = caseOwner.root;
      let shouldEdit = false;
      let editCount = 0;
      const agents = new ScriptedAgents((prompt) => {
        if (prompt.result === "notes") {
          return scriptedResult({
            summary: "Caching uses an in-memory map cleared on product updates.",
            notes: ["No external cache service is required."],
          });
        }
        if (prompt.result === "build") {
          if (shouldEdit) {
            editCount += 1;
            writeFileSync(join(prompt.cwd, "direct-change.txt"), `Single-agent edit ${editCount}\n`);
            return scriptedResult({ summary: `Wrote direct-change.txt (${editCount}).` });
          }
          return scriptedResult({ summary: "Everything already matched; no edits were needed." });
        }
        throw new Error(`Unexpected role result in single-agent test: ${prompt.result}`);
      });

      const engine = installSharedWorkflowFastPaths(
        caseOwner.open(join(root, "data"), {
          startAgentSession: agents.start,
          toolProbe: scriptedToolProbe({
            "claude-code": { status: "ready" },
            codex: { status: "ready" },
            grok: { status: "ready" },
            gh: { status: "not-installed" },
            git: { status: "ready" },
          }),
        }),
        {
          skipDriverPrepare: true,
          skipUpToDate: true,
          skipPrepareChecks: true,
          skipReviewCopies: true,
          skipReviewInputDiffs: true,
          fastCheckCapture: true,
          fastCleanup: true,
        },
      );

      try {
        const { path: repo } = await createProductRepository(root, { origin: "none" });
        const productId = await caseOwner.run(engine, async () => {
          await engine.waitUntilReady();
          caseOwner.check();
          return installPreparedProduct(engine, privateCloneProduct(repo));
        });
        engine.setProductChecks(productId, [{ name: "Git check", command: "git --version" }]);
        engine.setProductDelivery(productId, "local", false);
        const coordination = new Coordination(engine);

        const waitDone = (taskId: string) =>
          waitFor((): Task | undefined => {
            const task = engine.taskDetails(taskId);
            if (task?.state === "failed") throw new Error(`Direct task failed: ${task.error}`);
            return task?.state === "done" ? task : undefined;
          }, `task ${taskId} completion`, 30_000);

        // 1. Read-only single-agent task via CLI/MCP coordination ("task.add" with roleId + profileId)
        const researchCreated = (await coordination.call("task.add", {
          productId,
          title: "Investigate cache invalidation",
          description: "Check where cached entries are cleared.",
          roleId: "researcher",
          profileId: "opus-high",
          requestId: "direct-research-1",
        })) as unknown as { taskId: string };
        const researchTask = await waitDone(researchCreated.taskId);
        expect(researchTask.noProductChanges).toBe(true);
        expect(researchTask.statusLine).toBe("Completed · No product changes");
        expect(researchTask.handedBack?.[0]?.summary).toContain("Caching uses an in-memory map");
        expect(researchTask.checks).toBeUndefined();

        // 2. Editing single-agent task that makes zero file changes -> short-circuits cleanly with no product changes
        const unchangedBuilderId = engine.addTask({
          productId,
          title: "Remove obsolete flag if still present",
          direct: { roleId: "builder", profileId: "sol-high" },
        });
        const unchangedBuilderTask = await waitDone(unchangedBuilderId);
        expect(unchangedBuilderTask.noProductChanges).toBe(true);
        expect(unchangedBuilderTask.statusLine).toBe("Completed · No product changes");
        expect(unchangedBuilderTask.landed).toBeUndefined();

        // 3. Editing single-agent task with delivery approval & send-back -> skips Planner, Reviewers, and Guide keeper
        shouldEdit = true;
        let buildTurn = 0;
        const editingBuilderId = engine.addTask({
          productId,
          title: "Add direct-change.txt",
          delivery: "local",
          approveDelivery: true,
          direct: { roleId: "builder", profileId: "sol-high" },
        });
        const firstGate = await waitFor(() => {
          const state = engine.getState();
          const task = engine.taskDetails(editingBuilderId);
          if (task?.state === "failed") throw new Error(`Direct task failed: ${task.error}`);
          return state.inbox.find((item) => item.taskId === editingBuilderId && item.kind === "delivery");
        }, "direct task first delivery gate", 30_000);
        buildTurn = agents.received("build").length;
        engine.requestChanges(firstGate.id, "Add a second line before landing.");

        const secondGate = await waitFor(() => {
          const state = engine.getState();
          const task = engine.taskDetails(editingBuilderId);
          if (task?.state === "failed") throw new Error(`Direct task failed: ${task.error}`);
          if (agents.received("build").length <= buildTurn) return undefined;
          return state.inbox.find((item) => item.taskId === editingBuilderId && item.kind === "delivery");
        }, "direct task second delivery gate", 30_000);
        const gatedTask = engine.taskDetails(editingBuilderId)!;
        expect(gatedTask.fixing).toBe(false);
        expect(gatedTask.miss).toBeUndefined();
        expect(agents.received("guide")).toHaveLength(0);

        engine.approve(secondGate.id);
        const deliveredTask = await waitDone(editingBuilderId);
        expect(deliveredTask.noProductChanges).not.toBe(true);
        expect(deliveredTask.fixing).toBe(false);
        expect(deliveredTask.checks?.results.every((check) => check.ok)).toBe(true);
        expect(deliveredTask.landed?.branch).toBe("main");
        expect(readFileSync(join(repo, "direct-change.txt"), "utf8")).toBe("Single-agent edit 2\n");

        expect(agents.received("plan")).toHaveLength(0);
        expect(agents.received("findings")).toHaveLength(0);
        expect(agents.received("guide")).toHaveLength(0);
        expect(agents.received("notes")).toHaveLength(1);
        expect(agents.received("build")).toHaveLength(3);
      } finally {
        await caseOwner.stop(engine);
      }
    });
  });
});
