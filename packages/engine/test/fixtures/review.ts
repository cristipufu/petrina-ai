import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { type EngineCaseOwner } from "./engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ROLE_STARTS, type Task } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { PlanResult } from "../../src/roles.js";
import { PLANNER_PROFILE } from "../../src/kernel.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import type { Scenario } from "../fake-agent.js";
import { Fakes, createProductRepository, waitFor } from "../fixtures.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

export function reviewJourneyFixtures() {
  async function untilDelivery(owner: EngineCaseOwner, scenario: Scenario, poolLimit?: number, ship = false, input?: { entry: "builder"; skipDiffs?: boolean }) {
    const root = mkdtempSync(join(owner.root, "petrina-review-"));

    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    const engine = owner.open(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir],
      startAgentSession: fakeAgentSessions(fakes),
      toolProbe: privateAgentToolProbe() });
    installSharedWorkflowFastPaths(engine, {
      skipDriverPrepare: true,
      skipUpToDate: true,
      skipPrepareChecks: true,
      skipReviewCopies: scenario.reviewer !== "move-branch",
      ...(input?.skipDiffs ? { skipReviewInputDiffs: true } : {}),
      fastCheckCapture: true,
      fastCleanup: true,
    });
    let atOnce = 0;
    const unsubscribe = engine.subscribe(() => {
      for (const task of engine.getState().tasks) if (task.holdsSlot && task.agent) atOnce = Math.max(atOnce, 1 + (task.helpers?.length ?? 0));
    });
    try {
      return await owner.run(engine, async () => {
        const admitted = () => { owner.check(); engine.stopRequested.signal.throwIfAborted(); };
        if (input) admitted();
        if (poolLimit) engine.setPoolLimit(poolLimit);
        if (scenario.planner === "mixed-review") engine.addRole(ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
        const { path: repo, initialSha: before } = await createProductRepository(root, { origin: "none" });
        if (input) admitted();
        const productId = installPreparedProduct(engine, privateCloneProduct(repo));
        engine.setProductDelivery(productId, "local", true);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", ...(input ? { backlog: true } : {}) });
        if (input) {
          const task = engine.task(taskId)!, scope = executionFor(task), product = engine.productOf(scope)!;
          const allowed = new Set(["reviewer", "verifier", "builder", "fixes", "reviewRounds", "reopenedEvidence", "screenRoles", "reviewConfirmation"]);
          const active = () => {
            owner.check(); engine.stopRequested.signal.throwIfAborted();
            if (engine.task(taskId) !== task || executionFor(task).work !== scope.work || engine.productOf(scope) !== product
              || product.path !== scope.work.workProduct?.path || task.repositories || task.workRows || engine.drivers.has(taskId))
              throw new Error("The prepared review Builder lost its captured owner");
          };
          active();
          if (input.entry !== "builder" || Object.keys(scenario).some(key => !allowed.has(key))) throw new Error("The review Builder input requires the canonical greeting plan and brief");
          await engine.waitUntilReady(); active();
          await engine["sources"].propose(task, undefined); active();
          engine["sources"].confirm(task);
          // The fake's default [no-check] plan/brief, supplied before the first real Builder.
          // No Planner, architect or design-review execution is recorded for these prerequisites.
          const result = PlanResult.parse({ rationale: "A small feature: agree on a design, build it, two reviewers.", stages: [
            { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: scenario.reviewRounds ?? 2 },
          ] });
          task.risk = { level: "medium", why: "The planner did not rate it." };
          task.plan = engine["planning"]["normalizePlan"](task, result, engine.onUsable(PLANNER_PROFILE));
          task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: [{ text: "A greeting file exists" }], risks: [] };
          task.stageIndex = task.plan.stages.findIndex(stage => stage.kind === "do" && engine.role(stage.roleId, task)?.result === "build");
          if (task.stageIndex < 0 || scope.work.checks || task.journey?.some(step => step.kind === "agent"))
            throw new Error("The prepared review input cannot claim earlier check or participant execution");
          task.sub = 0; task.approvePlan = false; task.state = "waiting"; task.startedAt = Date.now();
          engine.commitNow(task); engine.schedule();
        }
        const task = await waitFor(() => {
          const state = engine.getState();
          for (const item of state.inbox) {
            if (item.taskId !== taskId) continue;
            if (item.kind === "plan") engine.approve(item.id);
            else if (item.kind === "permission") engine.allow(item.id, "once");
            else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
            else if (item.kind === "screen") engine.allowScreen(taskId);
          }
          const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
          if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
          if (ship) {
            const delivery = state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
            if (delivery) engine.approve(delivery.id);
            return found?.state === "done" && found;
          }
          return found && state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
        }, ship ? "the work to ship" : "the delivery check", 60_000);
        // A bounded pair of fresh voters from the tools that can run here (with none installed, the two tools the
        // reviewers were planned on). A pair that both say not blocking asks a third tool when one more was usable.
        const usable = engine.getState().tools.filter((tool) => tool.status === "ready").length || 2;
        const voters = Math.min(2, usable);
        const nonblocking = usable >= 3 ? 3 : voters;
        return { task, fakes, atOnce, repo, before, voters, nonblocking, root };

      });
    } finally {
      unsubscribe();
      await owner.stop(engine);
    }
  }
  const lines = (task: Task) => task.timeline.map((entry) => entry.text);

  return { untilDelivery, lines };
}
