import { describe, expect, it } from "vitest";
import { pipelineOf, queueOf, resumeTaskState, slotUses, type State } from "@petrina/core";
import { admissionFixture as fixture } from "../../fixtures/agent-workflow.js";
import { deferred } from "../../fixtures/tool-checks.js";

function counts(state: State) {
  const uses = slotUses(state);
  for (const task of state.tasks) if (task.holdsSlot) expect(task.agent, `slot on ${task.id}`).toBeDefined();
  return { total: uses.length, claude: uses.filter((use) => use.toolId === "claude-code").length, codex: uses.filter((use) => use.toolId === "codex").length };
}

describe("slots are recorded and checked for every agent", () => {
  for (const slots of [1, 2]) it(`does not allocate any of ${slots} free slots to a resumed task still stopping`, async () => {
    const f = fixture(slots, slots, slots + 1), stopped = f.task(f.ids[0]!)!;
    const settlement = deferred<void>();
    try {
      stopped.state = "paused";
      // The same owner used by AgentWorkflow retains a driver after Pause and through Resume.
      f.ownership.settling.set(stopped.id, settlement.promise);
      expect(resumeTaskState(stopped, false)).toBe(true);
      f.workflow.setPoolPaused(false);
      const queued = f.ids.slice(1).map(id => f.task(id)!);
      expect(stopped.state).toBe("waiting");
      expect(queued.map(task => task.holdsSlot)).toEqual(Array(slots).fill(true));
      expect(queued.map(task => task.state)).toEqual(Array(slots).fill("running"));
      expect(stopped.holdsSlot).toBe(false);
      expect(stopped.agent).toBeUndefined();
    } finally {
      settlement.resolve();
      f.ownership.settling.delete(stopped.id);
      await f.close();
    }
  });

  it("shows Plan and its planner immediately, before the working copy is ready", async () => {
    const f = await fixture(8, 5);
    try {
      f.workflow.setPoolPaused(false);
      const state = f.snapshot();
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
      const state = f.snapshot();
      const uses = slotUses(state);
      changes += 1;
      if (uses.length > 8 || uses.filter((use) => use.toolId === "claude-code").length > 3 || uses.filter((use) => use.toolId === "codex").length > 2 || state.tasks.some((task) => task.holdsSlot && !task.agent)) failures.push(JSON.stringify(uses));
    };
    const unsub = f.subscribe(check);
    try {
      f.workflow.setPoolPaused(false);
      await f.waitFor(() => {
        check();
        for (const prompt of f.agents.received()) f.release(prompt.sessionId);
        const state = f.snapshot();
        expect(state.tasks.filter((task) => task.state === "failed").map((task) => task.error)).toEqual([]);
        for (const item of state.inbox) {
          if (item.kind === "question") f.answer(item.id, "Formal");
          if (item.kind === "permission") f.allow(item.id, "once");
        }
        return state.tasks.every((task) => task.state === "needs-you") && state.inbox.every((item) => item.kind === "delivery");
      }, "every task to pass through mixed tools and reach delivery", 60_000);
      expect(changes).toBeGreaterThan(100);
      expect(failures).toEqual([]);
      expect(f.agents.received("notes")).toHaveLength(9);
      expect(f.agents.received("objections").length).toBeGreaterThan(9);
      expect(f.agents.received("findings")).toHaveLength(27);
    } catch (error) {
      const state = f.snapshot();
      const tasks = state.tasks.map(({ id, state, statusLine, error }) => ({ id, state, statusLine, error }));
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Tasks: ${JSON.stringify(tasks)}. Slots: ${JSON.stringify(slotUses(state))}. Cap violations: ${JSON.stringify(failures)}`, { cause: error });
    } finally { unsub(); await f.close(); }
  });

  for (const lowered of ["tool", "pool"] as const) {
    it(`lowering the ${lowered} limit from seven to five lets running agents finish, then holds same-tool successors`, async () => {
      const f = await fixture(9, 7);
      let reachedFive = false;
      const violations: number[] = [];
      const unsub = f.subscribe(() => {
        const count = counts(f.snapshot());
        const used = lowered === "tool" ? count.claude : count.total;
        if (used <= 5) reachedFive = true;
        if (reachedFive && used > 5) violations.push(used);
      });
      try {
        f.workflow.setPoolPaused(false);
        await f.waitFor(() => f.agents.received("plan").length === 7, "seven working planners");
        // Start checking the new limit only now; all seven have actually received their instructions.
        reachedFive = false;
        violations.length = 0;
        if (lowered === "tool") f.workflow.setToolCap("claude-code", 5);
        else f.workflow.setPoolLimit(5);
        expect(counts(f.snapshot()).claude).toBe(7);
        expect(f.snapshot().tasks.filter((task) => task.holdsSlot).every((task) => task.agent?.roleId === "planner")).toBe(true);

        const planners = f.agents.received("plan");
        for (let index = 0; index < 2; index += 1) {
          f.release(planners[index]!.sessionId);
          await f.waitFor(() => f.snapshot().tasks.filter((task) => task.state === "waiting").length === index + 1, "finished planner to wait for its next agent");
          expect(counts(f.snapshot()).claude).toBe(6 - index);
          expect(f.agents.received("notes")).toHaveLength(0);
        }
        const waiting = f.snapshot().tasks.find((task) => task.state === "waiting")!;
        expect(waiting.worktree).toBeDefined();
        expect(waiting.column).toBe("designing");
        expect(waiting.statusLine).toBe(lowered === "tool" ? "Waiting for a free Claude Code slot" : "Waiting for a free slot");
        expect(waiting.agent).toBeUndefined();
        expect(queueOf(f.snapshot().tasks)).toHaveLength(2);

        f.release(planners[2]!.sessionId);
        await f.waitFor(() => f.agents.received("notes").length > 0, "work in progress to continue ahead of the queue");
        expect(f.agents.received("plan")).toHaveLength(7);
        expect(counts(f.snapshot()).claude).toBe(5);
        expect(violations).toEqual([]);
      } finally { unsub(); await f.close(); }
    });
  }

  it("pausing the pool holds the next agent without stopping the current one", async () => {
    const f = await fixture(8, 1);
    try {
      f.workflow.setPoolPaused(false);
      await f.waitFor(() => f.agents.received("plan").length === 1, "a working planner");
      f.workflow.setPoolPaused(true);
      expect(counts(f.snapshot()).total).toBe(1);
      f.release(f.agents.received("plan")[0]!.sessionId);
      await f.waitFor(() => f.snapshot().tasks.some((task) => task.state === "waiting"), "the next agent to wait for the paused pool");
      expect(counts(f.snapshot()).total).toBe(0);
      expect(f.snapshot().tasks.find((task) => task.state === "waiting")!.statusLine).toBe("Waiting for the pool to resume");
      f.workflow.setPoolPaused(false);
      await f.waitFor(() => f.agents.received("notes").length === 1, "the task to carry on with its working copy");
      expect(f.agents.received("plan")).toHaveLength(1);
    } finally { await f.close(); }
  });
});
