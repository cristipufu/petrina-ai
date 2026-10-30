import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { Engine, fixtureEngineOptions, writeFixtureEngineOptions } from "../../engine.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { ADAPTERS, agentCommandFor } from "@petrina/agent-runtime/tools";
import { FAKE_AGENT, Fakes, removeDir, tempDir } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { TAKE_OVER_WORDS } from "@petrina/core";
import { ScriptedAgents } from "../../scripted-agents.js";
import { scriptedGitHub } from "../../scripted-github.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { scriptedContainerControl, scriptedContainerInspection } from "../../fixtures/container-inspection.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());
const root = tempDir("petrina-engine-boundary-");
afterAll(() => removeDir(root));
it("rejects process-local adapters before replacing a child fixture's settings", () => {
  const path = join(root, "blocked-child-options.json");
  writeFileSync(path, "Existing settings");
  expect(() => writeFixtureEngineOptions(path, { files: new FileFaults().files })).toThrow("File effects are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(path, { browserRecovery: async () => {} })).toThrow("Browser recovery is process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  const absent = join(root, "absent-child-options.json");
  expect(() => writeFixtureEngineOptions(absent, { browserRecovery: async () => {} })).toThrow("Browser recovery is process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(absent, { files: new FileFaults().files })).toThrow("File effects are process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(path, { startAgentSession: new ScriptedAgents(() => "").start })).toThrow("Agent sessions are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { startAgentSession: new ScriptedAgents(() => "").start })).toThrow("Agent sessions are process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(path, { github: scriptedGitHub({}) })).toThrow("GitHub services are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { github: scriptedGitHub({}) })).toThrow("GitHub services are process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(path, { toolProbe: scriptedToolProbe({}) })).toThrow("Tool probes are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { toolProbe: scriptedToolProbe({}) })).toThrow("Tool probes are process-local");
  expect(existsSync(absent)).toBe(false);
  const containerInspection = scriptedContainerInspection(join(root, "unopened-service"));
  expect(() => writeFixtureEngineOptions(path, { containerInspection })).toThrow("Container inspection is process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { containerInspection })).toThrow("Container inspection is process-local");
  expect(existsSync(absent)).toBe(false);
  expect(existsSync(join(root, "unopened-service"))).toBe(false);
  const containerControl = scriptedContainerControl(join(root, "unopened-service"), () => "owner");
  expect(() => writeFixtureEngineOptions(path, { containerControl })).toThrow("Container controls are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { containerControl })).toThrow("Container controls are process-local");
  expect(existsSync(absent)).toBe(false);
  const validationSnapshots = { snapshot: async () => {} };
  expect(() => writeFixtureEngineOptions(path, { validationSnapshots })).toThrow("Validation snapshots are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { validationSnapshots })).toThrow("Validation snapshots are process-local");
  expect(existsSync(absent)).toBe(false);
});
it("publishes child fixture configuration as data, leaving its guarded agent command to the child", () => {
  const path = join(root, "child-options.json");
  writeFixtureEngineOptions(path, { containerTool: [process.execPath, "private-container.ts"], extraCleanupEveryMs: 60_000,
    agentCommand: () => { throw new Error("The writer must not start an agent"); } });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ containerTool: [process.execPath, "private-container.ts"], extraCleanupEveryMs: 60_000 });
});
it("never creates a native usage reader by default, but lets a test explicitly supply its own", async () => {
  return engineCases.use("petrina-usage-fixture-", async caseOwner => {
  const path = caseOwner.root;
  const adapters = Object.values(ADAPTERS).filter(adapter => adapter.usageReader);
  const calls: string[] = [];
  const overrides = adapters.map(adapter => {
    const override = spyOn(adapter.usageReader!, "create");
    caseOwner.onStop(() => override.mockRestore());
    return override.mockImplementation(() => {
      calls.push(adapter.id);
      return { refresh: async () => {}, stop() {}, snapshot() {} } as ReturnType<NonNullable<typeof adapter.usageReader>["create"]>;
    });
  });
  let engine: Engine | undefined;
  try {
    engine = caseOwner.open(path, { toolPath: () => "/controlled/installed", awakeObserver: () => {}, terminals: () => [] });
    const initial = engine;
    await caseOwner.run(initial, () => initial.waitUntilReady());
    expect(calls).toEqual([]);
    expect(engine.usageCoordinator.readers.size).toBe(0);
    await caseOwner.stop(engine);
    const selected = adapters[0]!;
    engine = caseOwner.open(path, { usageCommands: { [selected.id]: ["fixture-owned-cli"] }, awakeObserver: () => {}, terminals: () => [] });
    const selectedEngine = engine;
    await caseOwner.run(selectedEngine, () => selectedEngine.waitUntilReady());
    expect(calls).toEqual([selected.id]);
    expect([...engine.usageCoordinator.readers.keys()]).toEqual([selected.id]);
  } finally {
    if (engine) await caseOwner.stop(engine);
    overrides.forEach(override => override.mockRestore());
  }
  });
});
for (const [label, callback] of [["no command", undefined], ["an undefined command", () => undefined], ["an empty command", () => []]] as const) it(`refuses native agent fallback with ${label}`, async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  const engine = caseOwner.open(join(root, crypto.randomUUID()), { agentCommand: callback });
  const start = spyOn(AgentRun, "start");
    caseOwner.onStop(() => start.mockRestore());
  try {
    const profile = engine.profile("sol-high")!;
    expect(() => agentCommandFor(engine.options, profile)).toThrow("native agent fallback is disabled");
    await caseOwner.run(engine, async () => { expect(String(await rejectionOf(engine.profileChoices({ toolId: "codex" })))).toContain("scripted agent command"); });
    expect(start).not.toHaveBeenCalled();
    expect(engine.usageCoordinator.readers.size).toBe(0);
  } finally { start.mockRestore(); await caseOwner.stop(engine); }
  });
});
it("gets tool availability from fake configuration and uses that command for configuration probes", async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  const fakes = new Fakes(join(root, "fake"));
  const engine = caseOwner.open(join(root, "configured"), { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir] });
  try {
    expect(engine.s.tools.every(tool => tool.status === "ready")).toBe(true);
    await caseOwner.run(engine, async () => { expect((await engine.profileChoices({ toolId: "codex" })).models.length).toBeGreaterThan(0); });
    expect(fakes.opens()).toHaveLength(1);
  } finally { await caseOwner.stop(engine); }
  });
});
for (const toolPath of [undefined, () => undefined]) it(`refuses native terminal-tool discovery with ${toolPath ? "an explicitly missing" : "no"} fixture executable`, async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  const engine = caseOwner.open(join(root, crypto.randomUUID()), { toolPath });
  try {
    for (const id of ["claude-code", "codex", "grok"]) await caseOwner.run(engine, async () => { expect(String(await rejectionOf(engine["takeover"]["takeOverTool"](id)))).toBe(`Error: ${TAKE_OVER_WORDS.missing(ADAPTERS[id]!.name)}`); });
  } finally { await caseOwner.stop(engine); }
  });
});
it("retains production terminal lookup when an optional executable override has no result", async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  const engine = caseOwner.open(join(root, crypto.randomUUID()), { toolPath: () => undefined });
  await caseOwner.run(engine, async () => { await engine.waitUntilReady(); });
  // Exercise just the production lookup branch; the spy prevents any machine-dependent discovery.
  engine.options.requireAgentCommand = false;
  const which = spyOn(Bun, "which");
    caseOwner.onStop(() => which.mockRestore());
    which.mockReturnValue("/controlled/codex");
  try {
    await caseOwner.run(engine, async () => { expect(await engine["takeover"]["takeOverTool"]("codex")).toEqual({ id: "codex", name: ADAPTERS.codex!.name, path: "/controlled/codex" }); });
    expect(which).toHaveBeenCalledWith(ADAPTERS.codex!.cli);
    expect(agentCommandFor({}, engine.profile("sol-high")!)).toBeUndefined();
  } finally { which.mockRestore(); await caseOwner.stop(engine); }
  });
});
it("shares its default boundary policy with the app-mode harness and lets tests inject services explicitly", () => {
  const defaults = fixtureEngineOptions(root);
  expect(defaults.requireAgentCommand).toBe(true);
  expect(defaults.which!("claude")).toBeNull();
  expect(defaults.which!("gh")).toBeNull();
  expect(defaults.terminals!()).toEqual([]);
  expect(defaults.browser).toBe(false);
  expect(defaults.gh!.at(-1)).toBe("GitHub");
  const own = fixtureEngineOptions(root, { gh: ["scripted-gh"], containerTool: ["scripted-container"], usageCommands: { codex: ["scripted-usage"] } });
  expect(own.gh).toEqual(["scripted-gh"]);
  expect(own.containerTool).toEqual(["scripted-container"]);
  expect(own.usageCommands?.codex).toEqual(["scripted-usage"]);
  expect(own.usageCommands?.grok).toBeNull();
});
it("retains a method-backed startup recovery owner through the canonical fixture", async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  class Recovery {
    readonly calls: { registry: string; root?: string }[] = [];
    async browserRecovery(registry: string, root?: string) { this.calls.push({ registry, root }); }
  }
  const recovery = new Recovery(), home = join(root, "method-recovery");
  const engine = caseOwner.open(home, recovery);
  try {
    await caseOwner.run(engine, async () => { await engine.waitUntilReady(); });
    expect(recovery.calls).toEqual([{ registry: join(home, "browser-temp"), root: undefined }]);
    expect(engine.drivers.size).toBe(0);
  } finally { await caseOwner.stop(engine); }
  });
});
it("records a synchronous startup-recovery failure on readiness without losing its owner", async () => {
  return engineCases.use("petrina-engine-case-", async caseOwner => {
  const root = caseOwner.root;
  const failure = new Error("Owned startup recovery could not inspect its processes");
  const engine = caseOwner.open(join(root, "synchronous-recovery"), { browserRecovery() { throw failure; } });
  try {
    await caseOwner.run(engine, async () => { expect(await rejectionOf(engine.waitUntilReady())).toBe(failure); });
    expect(engine.drivers.size).toBe(0);
  } finally { await caseOwner.stop(engine); }
  });
});
