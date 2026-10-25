import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pipelineOf, queueOf, slotUses, type State } from "@petrina/core";
import { Engine } from "../../engine.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

import { slotAgents } from "../../fixtures/slot-agents.js";

async function fixture(limit: number, toolCap: number) {
  const root = tempDir("petrina-limits-");
  const { agents, release } = slotAgents();
  const repo = await makeProduct(root);
  // Parallel worktree creation need not write upstream tracking settings to the shared config.
  await git(repo, "config", "branch.autoSetupMerge", "false");
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../unconfigured-service.ts"), "slot fixture"], startAgentSession: agents.start });
  engine.setPoolPaused(true);
  engine.setPoolLimit(limit);
  engine.setToolCap("claude-code", toolCap);
  engine.setToolCap("codex", 2);
  const productId = await engine.addProduct(repo);
  const ids = Array.from({ length: 9 }, (_, index) => engine.addTask({ productId, title: `Change ${index}`, approveDelivery: true }));
  const close = async () => {
    await engine.shutdown();
    removeDir(root);
  };
  return { engine, agents, ids, release, close, root, productId };
}

function counts(state: State) {
  const uses = slotUses(state);
  for (const task of state.tasks) if (task.holdsSlot) expect(task.agent, `slot on ${task.id}`).toBeDefined();
  return { total: uses.length, claude: uses.filter((use) => use.toolId === "claude-code").length, codex: uses.filter((use) => use.toolId === "codex").length };
}

describe("slots are recorded and checked for every agent", () => {
  it("shows Plan and its planner immediately, before the working copy is ready", async () => {
    const f = await fixture(8, 5);
    try {
      f.engine.setPoolPaused(false);
      const state = f.engine.getState();
      const started = state.tasks.filter((task) => task.holdsSlot);
      expect(started).toHaveLength(5);
      for (const task of started) {
        expect(task.worktree).toBeUndefined();
        expect(task.state).toBe("running");
        expect(task.column).toBe("planning");
        expect(task.agent).toMatchObject({ roleId: "planner", profileId: "opus-high" });
        expect(pipelineOf(task)).toEqual([{ label: "Plan", state: "current" }]);
        expect(queueOf(state.tasks).some((entry) => entry.id === task.id)).toBe(false);
      }
      expect(counts(state)).toEqual({ total: 5, claude: 5, codex: 0 });
    } finally { await f.close(); }
  });

  it("never exceeds either tool's cap, including reservations, same-tool handoffs and design/review rounds", async () => {
    const f = await fixture(8, 3);
    const failures: string[] = [];
    let changes = 0;
    const check = () => {
      const state = f.engine.getState();
      const uses = slotUses(state);
      changes += 1;
      if (uses.length > 8 || uses.filter((use) => use.toolId === "claude-code").length > 3 || uses.filter((use) => use.toolId === "codex").length > 2 || state.tasks.some((task) => task.holdsSlot && !task.agent)) failures.push(JSON.stringify(uses));
    };
    const unsub = f.engine.subscribe(check);
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => {
        check();
        for (const prompt of f.agents.received()) f.release(prompt.sessionId);
        const state = f.engine.getState();
        expect(state.tasks.filter((task) => task.state === "failed").map((task) => task.error)).toEqual([]);
        for (const item of state.inbox) {
          if (item.kind === "question") f.engine.answer(item.id, "Formal");
          if (item.kind === "permission") f.engine.allow(item.id, "once");
        }
        return state.tasks.every((task) => task.state === "needs-you") && state.inbox.every((item) => item.kind === "delivery");
      }, "every task to pass through mixed tools and reach delivery", 60_000);
      expect(changes).toBeGreaterThan(100);
      expect(failures).toEqual([]);
      expect(f.agents.received("notes")).toHaveLength(9);
      expect(f.agents.received("objections").length).toBeGreaterThan(9);
      expect(f.agents.received("findings")).toHaveLength(27);
    } catch (error) {
      const state = f.engine.getState();
      const tasks = state.tasks.map(({ id, state, statusLine, error }) => ({ id, state, statusLine, error }));
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Tasks: ${JSON.stringify(tasks)}. Slots: ${JSON.stringify(slotUses(state))}. Cap violations: ${JSON.stringify(failures)}`, { cause: error });
    } finally { unsub(); await f.close(); }
  });

  for (const lowered of ["tool", "pool"] as const) {
    it(`lowering the ${lowered} limit from seven to five lets running agents finish, then holds same-tool successors`, async () => {
      const f = await fixture(9, 7);
      let reachedFive = false;
      const violations: number[] = [];
      const unsub = f.engine.subscribe(() => {
        const count = counts(f.engine.getState());
        const used = lowered === "tool" ? count.claude : count.total;
        if (used <= 5) reachedFive = true;
        if (reachedFive && used > 5) violations.push(used);
      });
      try {
        f.engine.setPoolPaused(false);
        await waitFor(() => f.agents.received("plan").length === 7, "seven working planners");
        // Start checking the new limit only now; all seven have actually received their instructions.
        reachedFive = false;
        violations.length = 0;
        if (lowered === "tool") f.engine.setToolCap("claude-code", 5);
        else f.engine.setPoolLimit(5);
        expect(counts(f.engine.getState()).claude).toBe(7);
        expect(f.engine.getState().tasks.filter((task) => task.holdsSlot).every((task) => task.agent?.roleId === "planner")).toBe(true);

        const planners = f.agents.received("plan");
        for (let index = 0; index < 2; index += 1) {
          f.release(planners[index]!.sessionId);
          await waitFor(() => f.engine.getState().tasks.filter((task) => task.state === "waiting").length === index + 1, "finished planner to wait for its next agent");
          expect(counts(f.engine.getState()).claude).toBe(6 - index);
          expect(f.agents.received("notes")).toHaveLength(0);
        }
        const waiting = f.engine.getState().tasks.find((task) => task.state === "waiting")!;
        expect(waiting.worktree).toBeDefined();
        expect(waiting.column).toBe("designing");
        expect(waiting.statusLine).toBe(lowered === "tool" ? "Waiting for a free Claude Code slot" : "Waiting for a free slot");
        expect(waiting.agent).toBeUndefined();
        expect(queueOf(f.engine.getState().tasks)).toHaveLength(2);

        f.release(planners[2]!.sessionId);
        await waitFor(() => f.agents.received("notes").length > 0, "work in progress to continue ahead of the queue");
        expect(f.agents.received("plan")).toHaveLength(7);
        expect(counts(f.engine.getState()).claude).toBe(5);
        expect(violations).toEqual([]);
      } finally { unsub(); await f.close(); }
    });
  }

  it("pausing the pool holds the next agent without stopping the current one", async () => {
    const f = await fixture(8, 1);
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.agents.received("plan").length === 1, "a working planner");
      f.engine.setPoolPaused(true);
      expect(counts(f.engine.getState()).total).toBe(1);
      f.release(f.agents.received("plan")[0]!.sessionId);
      await waitFor(() => f.engine.getState().tasks.some((task) => task.state === "waiting"), "the next agent to wait for the paused pool");
      expect(counts(f.engine.getState()).total).toBe(0);
      expect(f.engine.getState().tasks.find((task) => task.state === "waiting")!.statusLine).toBe("Waiting for the pool to resume");
      f.engine.setPoolPaused(false);
      await waitFor(() => f.agents.received("notes").length === 1, "the task to carry on with its working copy");
      expect(f.agents.received("plan")).toHaveLength(1);
    } finally { await f.close(); }
  });
});
