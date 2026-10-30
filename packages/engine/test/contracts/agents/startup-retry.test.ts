import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
import type { Task } from "@petrina/core";
import { Fakes, makeProduct, waitFor, SLOW } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());



describe("a tool that never answers when it starts", () => {
  it("fails the step after the start limit instead of hanging it, and Try again starts it afresh", async () => {
  return engineCases.use("petrina-start-", async caseOwner => {
    const root = caseOwner.root;

    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "short" });
    // The first agent process never answers its handshake; the ones after it do.
    let silent = true;
    const options = {
      startTimeoutMs: 1000, // The first process deliberately never answers; its deadline can be short.
      toolProbe: privateAgentToolProbe(),
      agentCommand: () => {
        const command = [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), fakes.dir, ...(silent ? ["--silent"] : [])];
        silent = false;
        return command;
      },
    };
    const engine = caseOwner.open(join(root, "data"), options);
    try {
      const productId = await caseOwner.run(engine, async () => {
        const repo = await makeProduct(root, { origin: "none" });
        await engine.waitUntilReady();
        caseOwner.check(); engine.stopRequested.signal.throwIfAborted();
        return installPreparedProduct(engine, privateCloneProduct(repo));
      });
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
      const task = () => engine.getState().tasks.find((entry) => entry.id === taskId) as Task | undefined;
      // Generous: CI runners start a fake agent slowly, and the step fails only after the start limit.
      await waitFor(() => task()?.state === "failed", "the step to fail", 120_000);
      expect(task()!.error).toContain("did not start within");
      // No slot held by a tool that never answered.
      expect(task()!.holdsSlot).toBe(false);
      const stuck = engine.getState().inbox.find((item) => item.taskId === taskId && item.kind === "stuck")!;
      // The retry tests a healthy process, so allow for real startup time on a busy machine.
      engine.options.startTimeoutMs = 12_000 * SLOW;
      expect(engine.options.startTimeoutMs).toBe(12_000 * SLOW);
      // The fixture copied its input; this is deliberately the actual running Engine's option.
      expect(options.startTimeoutMs).toBe(1000);
      await caseOwner.run(engine, async () => { await engine.retry(stuck.id); });
      await waitFor(() => engine.getState().inbox.some((item) => item.taskId === taskId && item.kind === "plan") || task()?.stageIndex! >= 0, "the planner to answer after Try again", 120_000);
    } finally {
      await caseOwner.stop(engine);
    }

  });
});
});
