import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

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
    await expectRejection(run.profileChoices("invented"), "did not offer");
  } finally { await run?.stop(); removeDir(root); }
});
