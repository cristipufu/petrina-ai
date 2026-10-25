
import { expect, it } from "bun:test";



import { dispatch } from "../../../src/server.js";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { demoProfileChoices } from "@petrina/core";

it("joins discovery, caches it, and preserves catalog edits through an engine restart", async () => {
  const root = tempDir("profile-store-");
  let calls = 0;
  const options = { agentCommand: () => [] as string[], profileChoices: async (toolId: string, modelId?: string) => { calls++; return demoProfileChoices(toolId, modelId); } };
  let engine = new Engine(root, options); engine.setPoolPaused(true);
  try {
    await Promise.all([engine.profileChoices({ toolId: "codex" }), engine.profileChoices({ toolId: "codex" })]);
    expect(calls).toBe(1);
    await engine.profileChoices({ toolId: "codex" }); expect(calls).toBe(1);
    await engine.profileChoices({ toolId: "codex", refresh: true }); expect(calls).toBe(2);
    await engine.saveProfile({ toolId: "claude-code", modelId: "opus", effort: "medium" }, "created-profile");
    engine.removeProfile("opus-high");
    expect(engine.onUsable("opus-high")).not.toBe("opus-high");
    await engine.shutdown();
    engine = new Engine(root, options);
    expect(engine.s.profiles.some(p => p.id === "opus-high")).toBe(false);
    expect(engine.s.profiles.find(p => p.id === "created-profile")?.effort).toBe("medium");
    expect(engine.profile("opus-high")?.model).toBe("Opus 5.5");
  } finally { await engine.shutdown(); removeDir(root); }
});

it("round-trips default model discovery and explicit refresh through the JSON command boundary", async () => {
  const root = tempDir("profile-json-"); let calls = 0;
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => [], usageCommands: { codex: null, grok: null, antigravity: null }, profileChoices: async (tool, model) => { calls++; return demoProfileChoices(tool, model); } });
  const request = (options: { toolId: string; modelId?: string; refresh?: boolean }) => dispatch(engine, JSON.parse(JSON.stringify({ name: "profileChoices", args: [options] })));
  try {
    expect(await request({ toolId: "codex", refresh: false })).toEqual(demoProfileChoices("codex"));
    await request({ toolId: "codex", refresh: false }); expect(calls).toBe(1);
    await request({ toolId: "codex", refresh: true }); expect(calls).toBe(2);
    expect(await request({ toolId: "codex", modelId: "gpt-6-astra" })).toEqual(demoProfileChoices("codex", "gpt-6-astra"));
    expect(calls).toBe(3);
  } finally { await engine.shutdown(); removeDir(root); }
});
