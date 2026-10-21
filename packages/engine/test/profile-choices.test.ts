import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { Engine } from "../src/engine.js";
import { removeDir, tempDir } from "./support.js";
import { demoProfileChoices } from "@petrina/core";

it("reads model-specific native efforts without a prompt or browser", async () => {
  const root = tempDir("profile-config-"), file = join(root, "agent.mjs");
  writeFileSync(file, `import {createInterface} from 'node:readline';
let model='first';const config=()=>[{id:'model',currentValue:model,options:[{value:'first',name:'First'},{value:'second',name:'Second'}]},{id:'reasoning_effort',currentValue:'high',options:(model==='first'?['high']:['medium','high']).map(value=>({value,name:value}))}];
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
if(m.method==='session/new')result={sessionId:'config',configOptions:config()};
if(m.method==='session/set_config_option'){model=m.params.value;result={configOptions:config()};}
if(m.method==='session/prompt')throw Error('Configuration must never prompt');
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "probe", toolId: "grok", model: "ignored", effort: "high" }, cwd: root, signal: AbortSignal.timeout(5000), probe: true, browser: false, command: [process.execPath, file], callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } });
    expect(run.browser).toBeUndefined();
    expect((await run.profileChoices()).efforts).toEqual(["high"]);
    expect((await run.profileChoices("second")).efforts).toEqual(["medium", "high"]);
    await expect(run.profileChoices("invented")).rejects.toThrow("did not offer");
  } finally { await run?.stop(); removeDir(root); }
});
it("joins discovery, caches it, and preserves catalog edits through an engine restart", async () => {
  const root = tempDir("profile-store-");
  let calls = 0;
  const options = { agentCommand: () => [] as string[], profileChoices: async (toolId: string, modelId?: string) => { calls++; return demoProfileChoices(toolId, modelId); } };
  let engine = new Engine(root, options); engine.setPoolPaused(true);
  try {
    await Promise.all([engine.profileChoices("codex"), engine.profileChoices("codex")]);
    expect(calls).toBe(1);
    await engine.profileChoices("codex"); expect(calls).toBe(1);
    await engine.profileChoices("codex", undefined, true); expect(calls).toBe(2);
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
