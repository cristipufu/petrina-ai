import { describe as originalDescribe } from "bun:test";
import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");
import { afterAll, expect, it } from "bun:test";


import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";


import { Engine } from "../../engine.js";
import { Store } from "@petrina/storage/store";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
// Check behavior and cleanup limits do not depend on the host's power-log read: the fixtures' check runs and
// engines supply no records. Evidence cases pass their own; the native reader's contract lives in check-interruption.test.ts.
const root = (prefix: string) => {
  const dir = tempDir(prefix);
  roots.push(dir);
  return dir;
};


originalDescribe("Petrina runs the checks itself during a task", () => {
for (const outcome of ["pass", "fail"] as const) {
    it(`${outcome === "pass" ? "lets the review go ahead when they pass" : "sends the work back before any reviewer runs when they fail"}`, async () => {
      const dir = root("petrina-checks-task-");
      const product = await makeProduct(dir);
      const fakes = new Fakes(join(dir, "fake"));
      fakes.scenario({ planner: "short", checks: outcome });
      const engine = new Engine(join(dir, "data"), { agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "fake-agent.ts"), fakes.dir] });
      try {
        const productId = await engine.addProduct(product);
        engine.setProductDelivery(productId, "local", true);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
        const task = await waitFor(() => {
          const state = engine.getState();
          // Approve the plan like a coordinator would; everything else runs by itself.
          for (const item of state.inbox) {
            if (item.taskId !== taskId) continue;
            if (item.kind === "plan") engine.approve(item.id);
            else if (item.kind === "permission") engine.allow(item.id, "once");
            else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
          }
          const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
          if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
          return found && state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
        }, "the delivery check", 60_000);

        const finder = engine.getState().products.find((entry) => entry.id === productId)!;
        expect(finder.checksBy).toBe("finder");
        expect(finder.checks?.length).toBe(1);
        expect(task.checks?.results).toHaveLength(1);
        expect(existsSync(task.checks!.results[0]!.logPath!)).toBe(true);
        const reviewerRuns = task.timeline.filter((entry) => entry.text === "Code reviewer started").length;
        if (outcome === "pass") {
          expect(task.checks!.results[0]!.ok).toBe(true);
          expect(reviewerRuns).toBeGreaterThan(0);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Automated checks: all 1 passed");
        } else {
          expect(task.checks!.results[0]!.ok).toBe(false);
          // Reviewers never spent a turn on work whose checks fail.
          expect(reviewerRuns).toBe(0);
          expect(task.findings.some((finding) => finding.raisedBy === "petrina" && finding.text.startsWith("Check failed: Tests") && finding.evidence)).toBe(true);
          const fixing = fakes.received("builder").find((entry) => entry.text.includes("Saved failed-check output"));
          expect(fixing?.text).toContain(join(dir, "data", "checks", taskId));
          expect(fixing?.text).toContain("do not rerun just to recover the error");
          expect(task.timeline.some((entry) => entry.text.startsWith("Sent back to the builder"))).toBe(true);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Automated checks: 1 of 1 failed (Tests)");
        }
        // The finder ran once for the product, not once per review round.
        expect(task.timeline.filter((entry) => entry.text.startsWith("Found how to check")).length).toBe(1);
        const savedLog = task.checks!.results[0]!.logPath!;
        const contents = readFileSync(savedLog, "utf8");
        await engine.shutdown();
        const store = new Store(join(dir, "data", "petrina.db"));
        try {
          expect(store.load()!.tasks.find((entry) => entry.id === taskId)!.repository!.checks!.results[0]!.logPath).toBe(savedLog);
          expect(readFileSync(savedLog, "utf8")).toBe(contents);
        } finally { store.close(); }
      } finally {
        await engine.shutdown();
      }
    });
  }
});
