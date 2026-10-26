import { riskAgents } from "../../fixtures/risk-agents.js";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import type { Scenario } from "../../fake-agent.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** An engine with one product on local delivery that asks first, and a coordinator who approves plans and permissions. */
async function setUp(scenario: Scenario, shipLowRisk = false) {
  const root = tempDir("petrina-risk-");
  roots.push(root);
  const fakes = riskAgents(scenario.risk);
  const engine = new Engine(join(root, "data"), { startAgentSession: fakes.start, toolProbe: fakes.toolProbe });
  const productId = await engine.addProduct(await makeProduct(root));
  engine.updateProduct(productId, { name: "Shop", delivery: "local", approveDelivery: true, shipLowRisk });
  // Changing only the delivery keeps the low-risk choice.
  engine.setProductDelivery(productId, "local", true);
  const taskId = engine.addTask({ productId, title: "Add a greeting" });
  const step = (until: (state: State, task: Task | undefined) => unknown, what: string) =>
    waitFor(() => {
      const state = engine.getState();
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      }
      const task = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
      if (task?.state === "failed") throw new Error(`The task failed: ${task.error}`);
      return until(state, task) && task;
    }, what, 60_000) as Promise<Task>;
  const delivery = (state: State) => state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
  return { engine, fakes, productId, taskId, step, delivery };
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("review depth and the delivery check follow the task's risk", () => {
  it("adds a security review on another tool to high-risk work, and the planner never hears of Petrina's own roles", async () => {
    const f = await setUp({ planner: "short", risk: "high" });
    try {
      const task = await f.step((state) => f.delivery(state), "the delivery check");
      expect(task.risk).toEqual({ level: "high", why: "It changes how people sign in." });
      // The builder is on Codex, so the security reviewer is on Claude Code.
      expect(task.plan!.stages.find((stage) => stage.roleId === "security-reviewer")).toMatchObject({ kind: "review-chain", title: "Security review", profileIds: ["opus-xhigh"] });
      expect(f.fakes.openings("security reviewer")).toHaveLength(1);
      // The security review looked at the same commit: Petrina's checks were not run again for it.
      expect(lines(task).filter((line) => line.startsWith("Checks passed"))).toHaveLength(1);
      expect(f.delivery(f.engine.getState())!.body).toContain("High risk: It changes how people sign in.");

      const planner = f.fakes.openings("planner")[0]!;
      for (const word of ["check-finder", "Check finder", "verifier", "Verifier", "security-reviewer", "Security reviewer", "release-manager"]) expect(planner).not.toContain(word);
    } finally {
      await f.engine.shutdown();
    }
  });



  for (const optedIn of [true]) {
    it(optedIn ? "ships low-risk work without asking where the product opted in" : "still asks about low-risk work where the product did not opt in", async () => {
      const f = await setUp({ planner: "short", risk: "low" }, optedIn);
      try {
        expect(f.engine.getState().products[0]!.shipLowRisk).toBe(optedIn);
        if (optedIn) {
          const task = await f.step((state, found) => found?.state === "done" || f.delivery(state), "delivery or its check");
          expect(task.state).toBe("done");
          expect(f.delivery(f.engine.getState())).toBeUndefined();
          expect(lines(task)).toContain("Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
          expect(lines(task).some((line) => line === "You approved the delivery")).toBe(false);
        } else {
          const task = await f.step((state) => f.delivery(state), "the delivery check");
          expect(task.risk?.level).toBe("low");
        }
      } finally {
        await f.engine.shutdown();
      }
    });
  }

  it("asks again when the work changed after the delivery was approved", async () => {
    const f = await setUp({ planner: "short" });
    try {
      const first = await f.step((state) => f.delivery(state), "the delivery check");
      // Unrated work counts as medium.
      expect(first.risk?.level).toBe("medium");
      f.engine.setPoolPaused(true);
      f.engine.approve(f.delivery(f.engine.getState())!.id);
      await f.step((_, task) => task?.state === "waiting", "the delivery to wait for the paused pool");
      writeFileSync(join(first.worktree!, "late.txt"), "A change after the approval\n");
      await git(first.worktree!, "add", "late.txt");
      await git(first.worktree!, "commit", "--quiet", "-m", "A late change");
      f.engine.setPoolPaused(false);

      const task = await f.step((state) => f.delivery(state), "the delivery check again");
      expect(lines(task)).toContain("The work changed after you approved the delivery, so Petrina asks you again");
      expect(f.fakes.openings("release manager")).toHaveLength(0);
    } finally {
      await f.engine.shutdown();
    }
  });
});
