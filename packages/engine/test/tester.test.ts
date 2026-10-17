import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("the tester tries the change once, and the final code once more", () => {
  it("skips the tester in fix rounds, tries the final code before the delivery check, and sends a failure there back to the builder", async () => {
    const root = tempDir("petrina-tester-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    // Build, try it, two reviewers; the first review raises an Important finding; the fix changes the code; the
    // tester's pass on the final code fails once.
    fakes.scenario({ planner: "tester-first", reviewer: "important", fixes: "change", tester: "fail-once" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox) {
          if (item.taskId !== taskId) continue;
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
        if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
        return state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
      }, "the delivery check", 120_000);
      const lines = task.timeline.map((entry) => entry.text);
      // Once before the first review; not after the review's fix; once on the final code (failed); once more after that fix.
      expect(lines.filter((line) => line === "Tester started")).toHaveLength(3);
      expect(lines).toContain("Acceptance will be tried once more on the final code, right before your delivery check");
      expect(lines.filter((line) => line === "Trying the acceptance list once more on the final code")).toHaveLength(2);
      expect(lines).toContain("Sent back to the builder: 1 acceptance check failed on the final code");
      // The failure on the final code was fixed, and the tester saw the code that ships.
      const acceptance = task.findings.filter((finding) => finding.text.startsWith("Failed acceptance check"));
      expect(acceptance).toHaveLength(1);
      expect(acceptance[0]!.status).toBe("fixed");
      expect(task.testedPatch).toBeDefined();
      expect(task.retest).toBeUndefined();
    } finally {
      engine.shutdown();
    }
  });
});
