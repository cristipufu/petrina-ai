import { expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { tempDir, removeDir } from "../../fixtures.js";

  it("saves admission atomically, coalesces restart catch-up and does not overlap unfinished work", async () => {
    const root = tempDir("petrina-routine-admission-");
    const start = () => new Engine(join(root, "data"), { agentCommand: () => { throw new Error("Paused admission must not launch an agent"); } });
    let engine = start();
    const productId = "private-product";
    try {
      engine.setPoolPaused(true);
      await engine.waitUntilReady();
      engine.s.products.push({ id: productId, name: "Private product", repo: "local/private", tone: "blue" });
      const routineId = engine.saveRoutine({ name: "Focused maintenance", productId, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Inspect checkout behavior", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true });
      const due = engine.getState().routines!.find(r => r.id === routineId)!.nextAt;
      engine.pollRoutines(due);
      const run = { routineId, due, taskId: engine.getState().routines!.find(r => r.id === routineId)!.latestTaskId! };
      engine.pollRoutines(run.due); engine.pollRoutines(run.due - 86_400_000);
      expect(engine.getState().tasks.filter(t => t.maintenance)).toHaveLength(1);
      engine.pollRoutines(run.due + 20 * 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
      engine.cancel(run.taskId);
      await engine.shutdown(); engine = start(); engine.setPoolPaused(true);
      engine.pollRoutines(run.due + 20 * 86_400_000);
      expect(engine.getState().routines![0]!.latestTaskId).toBe(run.taskId);
      engine.pollRoutines(run.due + 30 * 86_400_000);
      const next = engine.getState().routines![0]!.latestTaskId!;
      expect(next).not.toBe(run.taskId); expect(engine.taskDetails(next)!.maintenance!.catchUp).toContain("latest missed");
      engine.setRoutineEnabled(run.routineId, false);
      engine.pollRoutines(run.due + 40 * 86_400_000);
      expect(engine.getState().routines![0]!.latestTaskId).toBe(next);
      engine.removeRoutine(run.routineId);
      engine.pollRoutines(run.due + 50 * 86_400_000);
      expect(engine.getState().routines).toEqual([]);
    } finally { await engine.shutdown(); removeDir(root); }
  });
