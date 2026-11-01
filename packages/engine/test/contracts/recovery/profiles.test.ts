import { join } from "node:path";
import { afterAll, expect, it } from "bun:test";
import { NativeToolProbe } from "../../../src/tool-probe.js";
import { FAKE_AGENT, Fakes } from "../../fixtures.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
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

it("upgrades saved catalogs with newly added providers, reconciles toolCaps and probes tools with zero active profiles", async () => {
  return cases.use("profile-provider-upgrade-", async (owner) => {
    const dataDir = join(owner.root, "data");
    const fakes = new Fakes(join(owner.root, "fakes"));
    const options = {
      admissionsClosed: true,
      agentCommand: (profile: { toolId: string }) => [
        process.execPath,
        FAKE_AGENT,
        fakes.dir,
        `--record-tool=${profile.toolId}`,
      ],
      usageCommands: { codex: null, grok: null, antigravity: null },
      terminals: () => [],
    };
    const probeCleanups: Promise<void>[] = [];
    let engine = owner.open(dataDir, options);
    try {
      engine.s.profiles = engine.s.profiles.filter(
        (profile) => profile.toolId !== "opencode" && profile.toolId !== "pi",
      );
      engine.s.retiredProfiles = (engine.s.retiredProfiles ?? []).filter(
        (profile) => profile.toolId !== "opencode" && profile.toolId !== "pi",
      );
      delete engine.s.pool.toolCaps["opencode"];
      delete engine.s.pool.toolCaps["pi"];
      engine.s.pool.toolCaps["legacy-removed-tool"] = 3;
      engine.commitNow();
      await owner.stop(engine);

      engine = owner.open(dataDir, options);
      expect(engine.s.profiles.some((profile) => profile.toolId === "opencode")).toBe(true);
      expect(engine.s.profiles.some((profile) => profile.toolId === "pi")).toBe(true);
      expect(engine.s.pool.toolCaps["opencode"]).toBe(3);
      expect(engine.s.pool.toolCaps["pi"]).toBe(3);
      expect("legacy-removed-tool" in engine.s.pool.toolCaps).toBe(false);

      // Even if a coordinator removes every active profile for a tool, NativeToolProbe still probes cleanly.
      const opencodeProfiles = engine.s.profiles.filter((profile) => profile.toolId === "opencode");
      engine.s.retiredProfiles = [...(engine.s.retiredProfiles ?? []), ...opencodeProfiles];
      engine.s.profiles = engine.s.profiles.filter((profile) => profile.toolId !== "opencode");

      const probe = new NativeToolProbe(engine);
      const result = await probe.run("opencode", {
        signal: engine.stopRequested.signal,
        onGone: (gone) => {
          probeCleanups.push(gone);
        },
      });
      expect(result.status).toBe("ready");
      await Promise.all(probeCleanups);
    } finally {
      await Promise.allSettled(probeCleanups);
      await owner.stop(engine);
    }
  });
});
