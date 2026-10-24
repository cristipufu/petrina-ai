import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { Engine, fixtureEngineOptions, writeFixtureEngineOptions } from "./engine.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import { AgentRun } from "../src/acp-run.js";
import { ADAPTERS, agentCommandFor } from "../src/tools.js";
import { FAKE_AGENT, Fakes, removeDir, tempDir } from "./fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { TAKE_OVER_WORDS } from "@petrina/core";
import { ScriptedAgents } from "./scripted-agents.js";
import { scriptedToolProbe } from "./scripted-probes.js";

const root = tempDir("petrina-engine-boundary-");
afterAll(() => removeDir(root));

it("rejects process-local adapters before replacing a child fixture's settings", () => {
  const path = join(root, "blocked-child-options.json");
  writeFileSync(path, "Existing settings");
  expect(() => writeFixtureEngineOptions(path, { files: new FileFaults().files })).toThrow("File effects are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  const absent = join(root, "absent-child-options.json");
  expect(() => writeFixtureEngineOptions(absent, { files: new FileFaults().files })).toThrow("File effects are process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(path, { startAgentSession: new ScriptedAgents(() => "").start })).toThrow("Agent sessions are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { startAgentSession: new ScriptedAgents(() => "").start })).toThrow("Agent sessions are process-local");
  expect(existsSync(absent)).toBe(false);
  expect(() => writeFixtureEngineOptions(path, { toolProbe: scriptedToolProbe({}) })).toThrow("Tool probes are process-local");
  expect(readFileSync(path, "utf8")).toBe("Existing settings");
  expect(() => writeFixtureEngineOptions(absent, { toolProbe: scriptedToolProbe({}) })).toThrow("Tool probes are process-local");
  expect(existsSync(absent)).toBe(false);
});

it("publishes child fixture configuration as data, leaving its guarded agent command to the child", () => {
  const path = join(root, "child-options.json");
  writeFixtureEngineOptions(path, { containerTool: [process.execPath, "private-container.ts"], extraCleanupEveryMs: 60_000,
    agentCommand: () => { throw new Error("The writer must not start an agent"); } });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ containerTool: [process.execPath, "private-container.ts"], extraCleanupEveryMs: 60_000 });
});

it("never creates a native usage reader by default, but lets a test explicitly supply its own", async () => {
  const path = tempDir("petrina-usage-fixture-");
  const adapters = Object.values(ADAPTERS).filter(adapter => adapter.usageReader);
  const calls: string[] = [];
  const overrides = adapters.map(adapter => spyOn(adapter.usageReader!, "create").mockImplementation(() => {
    calls.push(adapter.id);
    return { refresh: async () => {}, stop() {}, snapshot() {} } as ReturnType<NonNullable<typeof adapter.usageReader>["create"]>;
  }));
  let engine: Engine | undefined;
  try {
    engine = new Engine(path, { toolPath: () => "/controlled/installed", awakeObserver: () => {}, terminals: () => [] });
    await engine.waitUntilReady();
    expect(calls).toEqual([]);
    expect(engine.usageCoordinator.readers.size).toBe(0);
    await engine.shutdown();
    const selected = adapters[0]!;
    engine = new Engine(path, { usageCommands: { [selected.id]: ["fixture-owned-cli"] }, awakeObserver: () => {}, terminals: () => [] });
    await engine.waitUntilReady();
    expect(calls).toEqual([selected.id]);
    expect([...engine.usageCoordinator.readers.keys()]).toEqual([selected.id]);
  } finally {
    await engine?.shutdown();
    overrides.forEach(override => override.mockRestore());
    removeDir(path);
  }
});

for (const [label, callback] of [["no command", undefined], ["an undefined command", () => undefined], ["an empty command", () => []]] as const) it(`refuses native agent fallback with ${label}`, async () => {
  const engine = new Engine(join(root, crypto.randomUUID()), { agentCommand: callback });
  const start = spyOn(AgentRun, "start");
  try {
    const profile = engine.profile("sol-high")!;
    expect(() => agentCommandFor(engine.options, profile)).toThrow("native agent fallback is disabled");
    expect(String(await rejectionOf(engine.profileChoices({ toolId: "codex" })))).toContain("scripted agent command");
    expect(start).not.toHaveBeenCalled();
    expect(engine.usageCoordinator.readers.size).toBe(0);
  } finally { start.mockRestore(); await engine.shutdown(); }
});

it("gets tool availability from fake configuration and uses that command for configuration probes", async () => {
  const fakes = new Fakes(join(root, "fake"));
  const engine = new Engine(join(root, "configured"), { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir] });
  try {
    expect(engine.s.tools.every(tool => tool.status === "ready")).toBe(true);
    expect((await engine.profileChoices({ toolId: "codex" })).models.length).toBeGreaterThan(0);
    expect(fakes.opens()).toHaveLength(1);
  } finally { await engine.shutdown(); }
});

for (const toolPath of [undefined, () => undefined]) it(`refuses native terminal-tool discovery with ${toolPath ? "an explicitly missing" : "no"} fixture executable`, async () => {
  const engine = new Engine(join(root, crypto.randomUUID()), { toolPath });
  try {
    for (const id of ["claude-code", "codex", "grok"]) expect(String(await rejectionOf(engine["takeover"]["takeOverTool"](id)))).toBe(`Error: ${TAKE_OVER_WORDS.missing(ADAPTERS[id]!.name)}`);
  } finally { await engine.shutdown(); }
});

it("retains production terminal lookup when an optional executable override has no result", async () => {
  const engine = new Engine(join(root, crypto.randomUUID()), { toolPath: () => undefined });
  await engine.waitUntilReady();
  // Exercise just the production lookup branch; the spy prevents any machine-dependent discovery.
  engine.options.requireAgentCommand = false;
  const which = spyOn(Bun, "which").mockReturnValue("/controlled/codex");
  try {
    expect(await engine["takeover"]["takeOverTool"]("codex")).toEqual({ id: "codex", name: ADAPTERS.codex!.name, path: "/controlled/codex" });
    expect(which).toHaveBeenCalledWith(ADAPTERS.codex!.cli);
    expect(agentCommandFor({}, engine.profile("sol-high")!)).toBeUndefined();
  } finally { which.mockRestore(); await engine.shutdown(); }
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
