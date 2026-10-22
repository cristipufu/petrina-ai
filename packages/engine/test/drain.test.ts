import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { Engine } from "./engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Two reviewers held mid-turn by the controlled fake, every agent before them let through. */
async function reviewing() {
  const root = tempDir("petrina-drain-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ controlled: true });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  const released = new Set<string>();
  const release = (session: string) => {
    if (released.has(session)) return;
    released.add(session);
    writeFileSync(join(fakes.dir, `release-${session}`), "go");
  };
  const productId = await engine.addProduct(makeProduct(root));
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const settle = (state: State) => {
    for (const item of state.inbox) {
      if (item.kind === "plan") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
    // Everyone but the code reviewers is let through at once.
    for (const entry of fakes.received()) if (entry.role !== "code reviewer") release(entry.session);
  };
  await waitFor(() => {
    settle(engine.getState());
    return fakes.received("code reviewer").length >= 2;
  }, "two reviewers to be held mid-turn", 180_000);
  const reviewers = [...new Set(fakes.received("code reviewer").map((entry) => entry.session))];
  return { engine, fakes, taskId, productId, reviewers, release, settle };
}

describe("stopping gently", () => {
  it("starts nothing new while draining, waits for the reviewers in flight to hand back, then reports nothing left", async () => {
    const { engine, taskId, productId, reviewers, release, settle } = await reviewing();
    let releaseStops!: () => void;
    const stopping = new Promise<void>((resolve) => { releaseStops = resolve; });
    const finishing = new Set();
    for (const run of engine.helperRuns.get(taskId) ?? []) {
      const stop = run.stop.bind(run);
      run.stop = async () => { finishing.add(run); await stopping; return stop(); };
    }
    try {
      expect(engine.inFlight()).toBe(2);
      const seen: number[] = [];
      const drained = engine.drain(60_000, (left) => seen.push(left));
      // A task added now stays in the queue: no planner starts for it.
      const other = engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" });
      await Bun.sleep(1500);
      expect(engine.getState().tasks.find((task) => task.id === other)!.state).toBe("queued");
      // The reviewers hand back: the drain ends with nothing left, and both reports were saved.
      for (const session of reviewers) release(session);
      await waitFor(() => finishing.size === 2, "both reviewers to finish their turns");
      // Their process cleanup is still using the copies, so neither report has been handed back yet.
      expect(engine.inFlight()).toBe(2);
      expect(Object.keys(engine.getState().tasks.find((entry) => entry.id === taskId)!.hunt!.reported)).toHaveLength(0);
      releaseStops();
      expect(await drained).toBe(0);
      expect(seen[0]).toBe(2);
      expect(seen.at(-1)).toBe(0);
      const task = engine.getState().tasks.find((entry) => entry.id === taskId)!;
      expect(task.hunt ? Object.keys(task.hunt.reported).length : 2).toBe(2);
      // After the drain, the step that would start next waits for the restart instead.
      await waitFor(() => {
        settle(engine.getState());
        return engine.getState().tasks.find((entry) => entry.id === taskId)!.statusLine === "Waiting: Petrina is restarting";
      }, "the task to wait for the restart", 30_000);
    } finally {
      releaseStops();
      await engine.shutdown();
    }
  });

  it("gives up after the limit with the count of agents still in flight", async () => {
    const { engine, reviewers, release } = await reviewing();
    try {
      const started = Date.now();
      expect(await engine.drain(1500)).toBe(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      for (const session of reviewers) release(session);
    } finally {
      await engine.shutdown();
    }
  });
});
