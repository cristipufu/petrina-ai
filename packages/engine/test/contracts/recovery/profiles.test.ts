import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll } from "bun:test";
import { expect, it } from "bun:test";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("recovers duplicate profile choices once and retains the old definition only for history", async () => {
  return cases.use("profile-recovery-", async owner => {
  const root = owner.root;
  const options = { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] };
  let engine = owner.open(root, options);
  try {
    engine.s.products.push({ id: "p", name: "Product", repo: "acme/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Saved plan", backlog: true }))!;
    delete engine.s.profileCatalogSaved; // A catalog saved before profile editing was available.
    engine.s.profiles.push({ ...engine.profile("sol-high")!, id: "codex-high" });
    task.plan = { rationale: "Saved plan", plannerProfileId: "opus-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["codex-high"] }] };
    engine.commitNow();
    await owner.stop(engine);
    engine = owner.open(root, options);
    expect(engine.s.profiles.some(profile => profile.id === "codex-high")).toBe(false);
    expect(engine.profile("codex-high")?.toolId).toBe("codex");
    expect(engine.task(task.id)!.plan!.stages[0]!.profileIds).toEqual(["sol-high"]);
    await owner.stop(engine);
    engine = owner.open(root, options);
    expect(engine.s.retiredProfiles?.filter(profile => profile.id === "codex-high")).toHaveLength(1);
    expect(engine.profile("sol-high")?.modelId).toBe("gpt-6.1-sol");
  } finally { await owner.stop(engine); }

  });
});
