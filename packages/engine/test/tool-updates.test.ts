import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { removeDir, tempDir } from "./support.js";

it("publishes richer metadata only for the latest visible tool, without duplicate or plumbing activity", async () => {
  const root = tempDir("tool-updates-");
  const file = join(root, "agent.mjs");
  writeFileSync(file, `import {createInterface} from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const sessionId='activity';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
 if(m.method==='session/new')result={sessionId};
 if(m.method==='session/prompt'){
  for(const update of JSON.parse(m.params.prompt[0].text))send({method:'session/update',params:{sessionId,update}});
  result={stopReason:'end_turn'};
 }
 send({id:m.id,result});
});`);
  const activity: string[] = [];
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "fake", toolId: "grok", model: "fake", effort: "high" }, cwd: root,
      signal: AbortSignal.timeout(10_000), command: [process.execPath, file], browser: false,
      callbacks: { onActivity: text => activity.push(text), onPlanStep: () => {}, onPermission: async () => "deny" } });
    const call = (id: string, title = "Shell") => ({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status: "pending" });
    const update = (id: string, extra: object) => ({ sessionUpdate: "tool_call_update", toolCallId: id, ...extra });
    await run.prompt(JSON.stringify([
      call("one"), update("one", { rawInput: { description: "Inspect saved usage records" } }),
      update("one", { rawInput: null, title: null }), update("one", { status: "completed" }),
      update("one", { rawInput: { description: "Inspect saved usage records" } }),
      call("two", "Read"), update("one", { rawInput: { description: "Old late completion" }, status: "completed" }),
      update("two", { kind: "read", locations: [{ path: "/product/usage.ts" }] }),
      { ...call("todo", "TodoWrite"), kind: "other" }, update("todo", { rawInput: { description: "Private bookkeeping" } }),
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private thought" } },
      update("two", { title: "Stale tool" }), update("unknown", { title: "Unstarted tool" }),
    ]));
    expect(activity).toEqual(["Running a command", "Inspect saved usage records", "Running a command", "Reading usage.ts"]);
    await run.prompt(JSON.stringify([update("two", { rawInput: { description: "Previous turn" } })]));
    expect(activity).toHaveLength(4);
  } finally { await run?.stop(); removeDir(root); }
});
