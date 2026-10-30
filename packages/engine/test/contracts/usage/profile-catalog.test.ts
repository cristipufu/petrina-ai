import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";

import { expect, it } from "bun:test";



import { dispatch } from "../../../src/server.js";

import { demoProfileChoices } from "@petrina/core";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


it("joins discovery, caches it, and preserves catalog edits through an engine restart", async () => {
  return engineCases.use("profile-store-", async caseOwner => {
  const root = caseOwner.root;
  let calls = 0;
  const options = { agentCommand: () => [] as string[], profileChoices: async (toolId: string, modelId?: string) => { calls++; return demoProfileChoices(toolId, modelId); } };
  let engine = caseOwner.open(root, options); engine.setPoolPaused(true);
  try {
    await caseOwner.run(engine, async () => { await Promise.all([engine.profileChoices({ toolId: "codex" }), engine.profileChoices({ toolId: "codex" })]); });
    expect(calls).toBe(1);
    await caseOwner.run(engine, async () => { await engine.profileChoices({ toolId: "codex" }); }); expect(calls).toBe(1);
    await caseOwner.run(engine, async () => { await engine.profileChoices({ toolId: "codex", refresh: true }); }); expect(calls).toBe(2);
    await caseOwner.run(engine, async () => { await engine.saveProfile({ toolId: "claude-code", modelId: "opus", effort: "medium" }, "created-profile"); });
    engine.removeProfile("opus-high");
    expect(engine.onUsable("opus-high")).not.toBe("opus-high");
    await caseOwner.stop(engine);
    engine = caseOwner.open(root, options);
    expect(engine.s.profiles.some(p => p.id === "opus-high")).toBe(false);
    expect(engine.s.profiles.find(p => p.id === "created-profile")?.effort).toBe("medium");
    expect(engine.profile("opus-high")?.model).toBe("Opus 5.5");
  } finally { await caseOwner.stop(engine);  }

  });
});

it("round-trips default model discovery and explicit refresh through the JSON command boundary", async () => {
  return engineCases.use("profile-json-", async caseOwner => {
  const root = caseOwner.root; let calls = 0;
  const engine = caseOwner.open(root, { admissionsClosed: true, agentCommand: () => [], usageCommands: { codex: null, grok: null, antigravity: null }, profileChoices: async (tool, model) => { calls++; return demoProfileChoices(tool, model); } });
  const request = (options: { toolId: string; modelId?: string; refresh?: boolean }) => dispatch(engine, JSON.parse(JSON.stringify({ name: "profileChoices", args: [options] })));
  try {
    expect(await request({ toolId: "codex", refresh: false })).toEqual(demoProfileChoices("codex"));
    await request({ toolId: "codex", refresh: false }); expect(calls).toBe(1);
    await request({ toolId: "codex", refresh: true }); expect(calls).toBe(2);
    expect(await request({ toolId: "codex", modelId: "gpt-6-astra" })).toEqual(demoProfileChoices("codex", "gpt-6-astra"));
    expect(calls).toBe(3);
  } finally { await caseOwner.stop(engine);  }

  });
});
