// Manual probe: what an ACP adapter exposes. Not part of the test suite.
// bun run test/probe.ts <claude|codex> <cwd> [prompt]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import * as acp from "@agentclientprotocol/sdk";

const [which = "claude", cwd = process.cwd(), prompt] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const pkg = which === "codex" ? "@agentclientprotocol/codex-acp/dist/index.js" : "@agentclientprotocol/claude-agent-acp/dist/index.js";
const entry = require.resolve(pkg);
const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "pipe"], cwd });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
const updates: unknown[] = [];
const conn = new acp.ClientSideConnection(
  () => ({
    async requestPermission(params) {
      console.log("PERMISSION", JSON.stringify(params).slice(0, 600));
      const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]!;
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    },
    async sessionUpdate(params) {
      updates.push(params.update);
      const u = params.update as { sessionUpdate: string };
      if (u.sessionUpdate !== "agent_message_chunk" && u.sessionUpdate !== "agent_thought_chunk") console.log("UPDATE", JSON.stringify(u).slice(0, 400));
    },
  }),
  stream,
);
const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("INIT", JSON.stringify(init, null, 1).slice(0, 3000));
const session = await conn.newSession({ cwd, mcpServers: [] });
interface ProbeSessionView {
  models?: { currentModelId?: string; availableModels?: { modelId?: string }[] };
  configOptions?: { id: string; currentValue?: string; options?: { value?: string }[] }[];
  modes?: { currentModeId?: string; availableModes?: { id?: string }[] };
}
interface ProbeMessageChunk {
  sessionUpdate?: string;
  content?: { text?: string };
}
const s = session as unknown as ProbeSessionView;
console.log("MODELS", s.models?.currentModelId, JSON.stringify((s.models?.availableModels ?? []).map((m) => m.modelId)));
for (const o of s.configOptions ?? []) console.log("OPTION", o.id, o.currentValue, JSON.stringify((o.options ?? []).map((x) => x.value)));
console.log("MODES", s.modes?.currentModeId, JSON.stringify((s.modes?.availableModes ?? []).map((m) => m.id)));
if (prompt) {
  const result = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
  const text = (updates as ProbeMessageChunk[]).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
  console.log("PROMPT RESULT", JSON.stringify(result), "TEXT:", text.slice(0, 500));
}
child.kill();
process.exit(0);
