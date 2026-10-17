import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("the checks found for each set of CI and build files", () => {
  it("are reused by a task on an older base, instead of the Check finder running again", async () => {
    const root = tempDir("petrina-checks-seen-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    // The fix round changes the code, so the checks run again on it.
    fakes.scenario({ fixes: "change" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const repo = makeProduct(root);
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const settle = (state: State) => {
        for (const item of state.inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
      };
      const atDelivery = (taskId: string) =>
        waitFor(() => {
          const state = engine.getState();
          settle(state);
          const task = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
          if (task?.state === "failed") throw new Error(`The task failed: ${task.error}`);
          return state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
        }, "the delivery check", 60_000);
      const finds = (taskId: string) => engine.getState().tasks.find((entry) => entry.id === taskId)!.timeline.filter((entry) => entry.text === "Check finder started").length;

      const first = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      const check = await atDelivery(first);
      // Main's build files change: the next task's working copy has other ones.
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "true" } }, null, 2));
      git(repo, "add", "package.json");
      git(repo, "commit", "-q", "-m", "A package.json on main");
      const second = engine.addTask({ productId, title: "Add a farewell", description: "[no-check]" });
      await atDelivery(second);
      expect(finds(second)).toBe(1);

      // The first goes back for another review round on its own base: its checks were found already.
      engine.requestChanges(check.id, "Say hello twice");
      await waitFor(() => {
        const state = engine.getState();
        settle(state);
        return state.inbox.find((item) => item.taskId === first && item.kind === "delivery" && item.id !== check.id);
      }, "the first task's delivery check again", 60_000);
      expect(finds(first)).toBe(1);
    } finally {
      engine.shutdown();
    }
  });
});
