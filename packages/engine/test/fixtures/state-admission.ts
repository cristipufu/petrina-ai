import { ScriptedAgents } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
/** Admission controls need a genuine pending session, not ACP startup or a Git repository. */
export function heldPlanning() {
 const agents = new ScriptedAgents((prompt, signal) => {
   if (prompt.result !== "plan") throw new Error(`Unexpected admission participant: ${prompt.result}`);
   return new Promise<string>((_resolve, reject) => {
   const abort = () => reject(new Error("Scripted planning stopped"));
   signal.addEventListener("abort", abort, { once: true });
   if (signal.aborted) abort();
 }); });
 return { startAgentSession: agents.start,
   toolProbe: scriptedToolProbe({ codex: { status: "ready" }, "claude-code": { status: "not-installed" }, grok: { status: "not-installed" }, antigravity: { status: "not-installed" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" } }),
 };
}
