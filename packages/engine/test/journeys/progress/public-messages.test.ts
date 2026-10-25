import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { ReleaseEvents } from "../../release-events.js";
import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const parallel of [false, true]) it(`saves separate public messages before handoff, including parallel agents (${parallel})`, async () => {
  const root = tempDir("petrina-live-messages-");
  roots.push(root);
  const roleId = parallel ? "code-reviewer" : "builder";
  const releases = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    if (prompt.roleId === roleId) {
      callbacks.onMessage?.({ id: 1, text: "I'm checking " });
      callbacks.onMessage?.({ id: 1, text: "I'm checking the nearby cases." });
      callbacks.onMessage?.({ id: 2, text: "I'm tracing the shared flow." });
      await releases.wait("public-update", signal);
      callbacks.onMessage?.({ id: 3, text: "The change is ready." });
    }
    switch (prompt.result) {
      case "plan": return scriptedResult({ rationale: "Check public message recording.", stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: parallel ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: 1 },
      ] });
      case "build": writeFileSync(join(prompt.cwd, "greeting.txt"), "Hello\n"); return { text: scriptedResult({ summary: "The change is ready.", changes: ["A greeting"] }), ...(prompt.roleId === roleId ? { streamed: true } : {}) };
      case "findings": return { text: scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] }), ...(prompt.roleId === roleId ? { streamed: true } : {}) };
      case "check-discovery": return scriptedResult({ summary: "No automated checks.", checks: [] });
      default: throw new Error(`Unexpected message fixture work: ${prompt.result}`);
    }
  });
  const engine = new Engine(join(root, "data"), { agentCommand: () => ["unused-scripted-session"], startAgentSession: agents.start });
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
    releases.release("public-update");
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
    releases.release("public-update");
    await engine.shutdown();
  }
});
