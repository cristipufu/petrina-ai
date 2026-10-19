// ACP stand-in that actually connects to the supplied MCP server on every opening.
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Readable, Writable } from "node:stream";
const clients: Client[] = [];
let details: unknown;
async function open(params: acp.NewSessionRequest | acp.ResumeSessionRequest | acp.LoadSessionRequest) {
  const browser = params.mcpServers![0]!;
  if (!("url" in browser) || !("headers" in browser)) throw new Error("No browser supplied");
  const client = new Client({ name: "session check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(browser.url), { requestInit: { headers: Object.fromEntries(browser.headers.map((header) => [header.name, header.value])) } }));
  clients.push(client);
  details = { params, tools: (await client.listTools()).tools.map((tool) => tool.name), codex: JSON.parse(process.env.CODEX_CONFIG ?? "{}"), codexPath: process.env.CODEX_PATH };
  return { sessionId: "test-session", configOptions: [] };
}
acp.agent({ name: "browser stand-in" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: process.env.FAKE_REOPEN === "load" ? { loadSession: true } : { sessionCapabilities: { resume: {} } } }))
  .onRequest("session/new", (ctx) => open(ctx.params))
  .onRequest("session/resume", async (ctx) => { if (process.env.FAKE_REOPEN === "fail") throw new Error("Reopen failed"); return open(ctx.params); })
  .onRequest("session/load", (ctx) => open(ctx.params))
  .onRequest("session/prompt", async (ctx) => {
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(details) } } });
    return { stopReason: "end_turn" };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
process.stdin.on("end", async () => { await Promise.all(clients.map((client) => client.close())); process.exit(0); });
