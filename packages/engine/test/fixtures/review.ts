import { type EngineCaseOwner } from "./engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ROLE_STARTS, type Task } from "@petrina/core";
import type { Scenario } from "../fake-agent.js";
import { Fakes, git, makeProduct, waitFor } from "../fixtures.js";
export function reviewJourneyFixtures() {
  async function untilDelivery(owner: EngineCaseOwner, scenario: Scenario, poolLimit?: number, ship = false) {
    const root = mkdtempSync(join(owner.root, "petrina-review-"));

    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    const engine = owner.open(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir] });
    let atOnce = 0;
    const unsubscribe = engine.subscribe(() => {
      for (const task of engine.getState().tasks) if (task.holdsSlot && task.agent) atOnce = Math.max(atOnce, 1 + (task.helpers?.length ?? 0));
    });
    try {
      return await owner.run(engine, async () => {
        if (poolLimit) engine.setPoolLimit(poolLimit);
        if (scenario.planner === "mixed-review") engine.addRole(ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
        const repo = await makeProduct(root);
        const before = await git(repo, "rev-parse", "HEAD");
        const productId = await engine.addProduct(repo);
        engine.setProductDelivery(productId, "local", true);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
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
