import { afterAll, describe, expect, it } from "bun:test";
import { finish, taskOf } from "../../support.js";
import { sourceWorlds, branch, advance } from "../../fixtures/source-world.js";
const { setup, close } = sourceWorlds();
afterAll(close);

describe.concurrent("review findings for a confirmed start",()=>{
it("names the branch when its movement conflicts", async () => {
    const { w, start } = await setup("branch-conflict", { builder: undefined });
    await branch(w);
    const engine = start();
    let landed = false;
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", description: "[quick]", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" });
      const task = taskOf(await finish(engine, id, async (eng, state) => {
        if (!landed && eng.task(id)?.agent?.roleId === "builder" && state.inbox.some((item) => item.taskId === id && item.kind === "permission")) {
          landed = true;
          await advance(w, w.remote, "release-2.x", "greeting.txt", "Hi from the branch\n");
          // The snapshot predates the branch's new commit: answer from what the engine shows now.
          state = eng.getState();
        }
        for (const item of state.inbox) {
          if (item.taskId !== id) continue;
          if (item.kind === "question") eng.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") eng.allow(item.id, "once");
          else if (item.kind === "plan" || item.kind === "design" || item.kind === "delivery") eng.approve(item.id);
        }
      }), id);
      expect(landed).toBe(true);
      expect(task.error).toBeUndefined();
      const update = task.journey?.find((step) => step.work === "update");
      expect(update?.outcome).toBe("1 file conflicts with release-2.x");
      expect(update?.reason).toBe("release-2.x moved on");
      expect(task.timeline.some((entry) => entry.text.includes("release-2.x moved on"))).toBe(true);
      expect(update?.outcome).not.toContain("main");
    } finally { await engine.shutdown(); }
  });
});
