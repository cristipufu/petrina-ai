import { expect, it } from "bun:test";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";

it("recovers duplicate profile choices once and retains the old definition only for history", async () => {
  const root = tempDir("profile-recovery-");
  const options = { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] };
  let engine = new Engine(root, options);
  try {
    engine.s.products.push({ id: "p", name: "Product", repo: "acme/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Saved plan", backlog: true }))!;
    delete engine.s.profileCatalogSaved; // A catalog saved before profile editing was available.
    engine.s.profiles.push({ ...engine.profile("sol-high")!, id: "codex-high" });
    task.plan = { rationale: "Saved plan", plannerProfileId: "opus-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["codex-high"] }] };
    engine.commitNow();
    await engine.shutdown();
    engine = new Engine(root, options);
    expect(engine.s.profiles.some(profile => profile.id === "codex-high")).toBe(false);
    expect(engine.profile("codex-high")?.toolId).toBe("codex");
    expect(engine.task(task.id)!.plan!.stages[0]!.profileIds).toEqual(["sol-high"]);
    await engine.shutdown();
    engine = new Engine(root, options);
    expect(engine.s.retiredProfiles?.filter(profile => profile.id === "codex-high")).toHaveLength(1);
    expect(engine.profile("sol-high")?.modelId).toBe("gpt-6.1-sol");
  } finally { await engine.shutdown(); removeDir(root); }
});
