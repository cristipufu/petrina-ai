import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor, SLOW } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("a tool that never answers when it starts", () => {
  it("fails the step after the start limit instead of hanging it, and Try again starts it afresh", async () => {
    const root = tempDir("petrina-start-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({});
    // The first agent process never answers its handshake; the ones after it do.
    let silent = true;
    const engine = new Engine(join(root, "data"), {
      startTimeoutMs: 12_000 * SLOW, // Short enough for the test, long enough for a healthy agent to start on a busy machine or a slow runner.
      agentCommand: () => {
        const command = [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, ...(silent ? ["--silent"] : [])];
        silent = false;
        return command;
      },
    });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      const task = () => engine.getState().tasks.find((entry) => entry.id === taskId) as Task | undefined;
      // Generous: CI runners start a fake agent slowly, and the step fails only after the start limit.
      await waitFor(() => task()?.state === "failed", "the step to fail", 120_000);
      expect(task()!.error).toContain("did not start within");
      // No slot held by a tool that never answered.
      expect(task()!.holdsSlot).toBe(false);
      const stuck = engine.getState().inbox.find((item) => item.taskId === taskId && item.kind === "stuck")!;
      engine.retry(stuck.id);
      await waitFor(() => engine.getState().inbox.some((item) => item.taskId === taskId && item.kind === "plan") || task()?.stageIndex! >= 0, "the planner to answer after Try again", 120_000);
    } finally {
      engine.shutdown();
    }
  });
});
