import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { journeyProblems, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("tasks' checks take turns on one machine", () => {
  it("runs one task's checks while the other waits its turn, and both get through", async () => {
    const root = tempDir("petrina-check-turns-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ checks: "slow" });
    const engine = new Engine(join(root, "data"), { checkRuns: 1, agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    let waited = false;
    let waitingStep: { taskId: string; stepId: string; startedAt: number } | undefined;
    const unsubscribe = engine.subscribe(() => {
      const task = engine.getState().tasks.find((task) => task.statusLine === "Waiting to run the checks: another task's run comes first");
      if (task) {
        waited = true;
        const step = task.journey!.at(-1)!;
        expect(step).toMatchObject({ kind: "petrina", work: "checks" });
        expect(step.endedAt).toBeUndefined();
        waitingStep = { taskId: task.id, stepId: step.id, startedAt: step.startedAt };
      }
    });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const ids = [engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" }), engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" })];
      await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        const tasks = ids.map((id) => state.tasks.find((entry) => entry.id === id) as Task | undefined);
        if (tasks.some((task) => task?.state === "failed")) throw new Error("a task failed");
        return ids.every((id) => state.inbox.some((item) => item.taskId === id && item.kind === "delivery"));
      }, "both delivery checks", 90_000);
      expect(waited).toBe(true);
      const task = engine.getState().tasks.find((task) => task.id === waitingStep!.taskId)!;
      expect(task.journey!.find((step) => step.id === waitingStep!.stepId)).toMatchObject({ startedAt: waitingStep!.startedAt, end: "done", outcome: "The check passes" });
      for (const task of engine.getState().tasks) expect(journeyProblems(task)).toEqual([]);
    } finally {
      unsubscribe();
      engine.shutdown();
    }
  });
});
