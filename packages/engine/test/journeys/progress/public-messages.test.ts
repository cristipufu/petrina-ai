import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { prepareProgressEntry } from "../../fixtures/progress-entry.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { ReleaseEvents } from "../../release-events.js";
import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProductRepository, waitFor } from "../../fixtures.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());



it("saves separate public messages before handoff, including parallel agents", async () => {
  return engineCases.use("petrina-live-messages-", async caseOwner => {
  const root = caseOwner.root;

  const releases = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    if (prompt.roleId === "builder" || prompt.roleId === "code-reviewer") {
      callbacks.onMessage?.({ id: 1, text: "I'm checking " });
      callbacks.onMessage?.({ id: 1, text: "I'm checking the nearby cases." });
      callbacks.onMessage?.({ id: 2, text: "I'm tracing the shared flow." });
      await releases.wait(`public-update:${prompt.roleId}`, signal);
      callbacks.onMessage?.({ id: 3, text: "The change is ready." });
    }
    switch (prompt.result) {
      case "build": writeFileSync(join(prompt.cwd, "greeting.txt"), "Hello\n"); return { text: scriptedResult({ summary: "The change is ready.", changes: ["A greeting"] }), streamed: true };
      case "findings": return { text: scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] }), streamed: true };
      default: throw new Error(`Unexpected message fixture work: ${prompt.result}`);
    }
  });
  const engine = caseOwner.open(join(root, "data"), { agentCommand: () => ["unused-scripted-session"], startAgentSession: agents.start, toolProbe: privateAgentToolProbe() });
  try {
    engine.setPoolPaused(true);
    const repository = await createProductRepository(root), path = repository.path;
    caseOwner.check();
    await engine.waitUntilReady();
    caseOwner.check();
    const productId = installPreparedProduct(engine, privateCloneProduct(path));
    const id = engine.addTask({ productId, title: "A clear live conversation", description: "[no-check]", backlog: true });
    await prepareProgressEntry(caseOwner, engine, id, true, "sol-high", repository);
    caseOwner.check();
    engine.queueTask(id);
    engine.setPoolPaused(false);
    const current = () => engine.getState().tasks.find((task) => task.id === id)!;
    for (const [roleId, expected] of [["builder", 1], ["code-reviewer", 2]] as const) {
      await waitFor(() => {
        for (const item of engine.getState().inbox) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, "Yes");
        }
        return current().session.filter((line) => line.from === "agent" && line.roleId === roleId && line.text === "I'm checking the nearby cases.").length === expected;
      }, `${roleId} public updates before handoff`, 30_000);
      expect(current().journey!.at(-1)!.endedAt).toBeUndefined();
      releases.release(`public-update:${roleId}`);
    }
    await waitFor(() => {
      for (const item of engine.getState().inbox) {
        if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, "Yes");
      }
      return engine.getState().inbox.some((item) => item.taskId === id && item.kind === "delivery");
    }, "the delivery check", 30_000);
    for (const [roleId, expectedProfiles] of [["builder", 1], ["code-reviewer", 2]] as const) {
      const messages = current().session.filter((line) => line.from === "agent" && line.roleId === roleId);
      const profiles = new Set(messages.map((line) => line.profileId));
      expect(profiles.size).toBe(expectedProfiles);
      for (const profileId of profiles) {
        const own = messages.filter((line) => line.profileId === profileId);
        expect(own.filter((line) => line.text === "I'm checking the nearby cases.")).toHaveLength(1);
        expect(own.filter((line) => line.text === "I'm tracing the shared flow.")).toHaveLength(1);
        expect(own.some((line) => line.text.startsWith("The change is ready."))).toBe(true);
        expect(own.every((line) => !line.text.includes("```"))).toBe(true);
        expect(new Set(own.map((line) => line.step)).size).toBe(1);
      }
    }
  } finally {
    releases.release("public-update:builder");
    releases.release("public-update:code-reviewer");
    await caseOwner.stop(engine);
  }

  });
});
