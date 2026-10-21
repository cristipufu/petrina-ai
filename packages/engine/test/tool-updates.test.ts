import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { removeDir, tempDir } from "./support.js";
import type { ToolActivityEvent } from "../src/tool-invocations.js";

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
  for(const update of JSON.parse(m.params.prompt[0].text)){
   if(update.crash){send({id:m.id,error:{code:-32603,message:'Turn failed'}});return;}
   send({method:'session/update',params:{sessionId,update}});
  }
  result={stopReason:'end_turn'};
 }
 send({id:m.id,result});
});`);
  const activity: string[] = [];
  const events: ToolActivityEvent[] = [];
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "fake", toolId: "grok", model: "fake", effort: "high" }, cwd: root,
      signal: AbortSignal.timeout(10_000), command: [process.execPath, file], browser: false,
      callbacks: { onActivity: text => activity.push(text), onToolActivity: event => events.push(structuredClone(event)), onPlanStep: () => {}, onPermission: async () => "deny" } });
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
    expect(events.filter(event => event.isNew)).toHaveLength(2);
    expect(events.find(event => event.invocation?.toolCallId === "one" && event.invocation.status === "completed")?.invocation?.endedAt).toBeNumber();
    expect(events.at(-1)?.runningTool).toBeUndefined();
    expect(events.at(-1)?.turnEndedAt).toBeNumber();
    await run.prompt(JSON.stringify([update("two", { rawInput: { description: "Previous turn" } })]));
    expect(activity).toHaveLength(4);
    const before = events.filter(event => event.invocation).length;
    await run.prompt(JSON.stringify([call("repeat"), update("repeat", { status: "completed" }), call("again"), update("again", { status: "failed" })]));
    expect(events.filter(event => event.isNew)).toHaveLength(4);
    expect(events.filter(event => event.invocation).slice(before).map(event => [event.invocation!.toolCallId, event.invocation!.status])).toEqual([["repeat", "pending"], ["repeat", "completed"], ["again", "pending"], ["again", "failed"]]);
    await expect(run.prompt(JSON.stringify([call("unfinished"), { crash: true }]))).rejects.toThrow("Turn failed");
    expect(events.at(-1)?.runningTool).toBeUndefined();
    expect(events.at(-1)?.turnEndedAt).toBeNumber();
    const unfinished = events.filter(event => event.invocation?.toolCallId === "unfinished");
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]!.invocation!.status).toBe("pending");
    expect(unfinished[0]!.invocation!.endedAt).toBeUndefined();
    // A failed turn's call cannot be mistaken for an invocation in the recovery turn.
    await run.prompt(JSON.stringify([update("unfinished", { status: "completed" }), call("recovered")]));
    expect(events.filter(event => event.invocation?.toolCallId === "unfinished")).toHaveLength(1);
    expect(events.filter(event => event.isNew).at(-1)?.invocation?.toolCallId).toBe("recovered");
  } finally { await run?.stop(); removeDir(root); }
});
