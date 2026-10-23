import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const parallel of [false, true]) it(`saves separate public messages before handoff, including parallel agents (${parallel})`, async () => {
  const root = tempDir("petrina-live-messages-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  const roleId = parallel ? "code-reviewer" : "builder";
  fakes.scenario({ planner: parallel ? "parallel" : "short", liveMessageRoles: [parallel ? "code reviewer" : "builder"] });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    const id = engine.addTask({ productId, title: "A clear live conversation", description: "[no-check]" });
    const current = () => engine.getState().tasks.find((task) => task.id === id)!;
    await waitFor(() => {
      for (const item of engine.getState().inbox) {
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, "Yes");
      }
      return current().session.filter((line) => line.from === "agent" && line.roleId === roleId && line.text === "I'm checking the nearby cases.").length === (parallel ? 2 : 1);
    }, "public updates before agents finish", 30_000);
    expect(current().journey!.at(-1)!.endedAt).toBeUndefined();
    writeFileSync(join(fakes.dir, "public-update-release"), "go");
    await waitFor(() => {
      for (const item of engine.getState().inbox) {
        if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, "Yes");
      }
      return engine.getState().inbox.some((item) => item.taskId === id && item.kind === "delivery");
    }, "the delivery check", 30_000);
    const messages = current().session.filter((line) => line.from === "agent" && line.roleId === roleId);
    for (const profileId of new Set(messages.map((line) => line.profileId))) {
      const own = messages.filter((line) => line.profileId === profileId);
      expect(own.filter((line) => line.text === "I'm checking the nearby cases.")).toHaveLength(1);
      expect(own.filter((line) => line.text === "I'm tracing the shared flow.")).toHaveLength(1);
      expect(own.some((line) => line.text.startsWith("The change is ready."))).toBe(true);
      expect(own.every((line) => !line.text.includes("```"))).toBe(true);
      expect(new Set(own.map((line) => line.step)).size).toBe(1);
    }
  } finally {
    writeFileSync(join(fakes.dir, "public-update-release"), "go");
    await engine.shutdown();
  }
});
