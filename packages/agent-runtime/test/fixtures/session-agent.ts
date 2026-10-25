// Native ACP peer for lifecycle and launch contracts. It has no workflow roles, Git, accounts or Engine.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";

const stubborn = process.argv.includes("--stubborn");
if (stubborn) { process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); }
const select = (id: string, values: string[]): acp.SessionConfigOption => ({ type: "select", id, name: id, currentValue: values[0]!, options: values.map(value => ({ value, name: value })) });
const options = () => [
  select("model", ["default", "opus", "gpt-6.1-sol"]),
  select("effort", ["high", "xhigh"]),
  select("reasoning_effort", ["low", "medium", "high", "xhigh", "ultra"]),
  select("thinking_level", ["low", "medium", "high"]),
  select("mode", ["default", "auto", "agent", "auto_edit", "yolo"]),
];
const record = join(process.cwd(), ".native-sessions.json");
const sessions = new Map<string, acp.SessionConfigOption[]>(existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : []);
const keep = () => writeFixtureJson(record, [...sessions]);
const sessionOptions = (id: string) => { const current = sessions.get(id); if (!current) throw acp.RequestError.invalidParams("Fixture session not found"); return current; };
acp.agent({ name: "native session fixture" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } }))
  .onRequest("session/new", async () => {
    if (process.argv.includes("--logged-out")) throw acp.RequestError.authRequired();
    if (process.argv.includes("--hang")) await new Promise(() => undefined);
    const sessionId = crypto.randomUUID();
    const configOptions = options();
    sessions.set(sessionId, configOptions); keep();
    return { sessionId, configOptions };
  })
  .onRequest("session/resume", ctx => ({ configOptions: sessionOptions(ctx.params.sessionId) }))
  .onRequest("session/set_config_option", ctx => {
    const configOptions = sessionOptions(ctx.params.sessionId);
    const option = configOptions.find(option => option.id === ctx.params.configId);
    if (option?.type !== "select" || typeof ctx.params.value !== "string" || !option.options.some(choice => "value" in choice && choice.value === ctx.params.value)) throw acp.RequestError.invalidParams("Fixture setting not supported");
    option.currentValue = ctx.params.value; keep();
    return { configOptions };
  })
  .onRequest("session/prompt", async ctx => {
    sessionOptions(ctx.params.sessionId);
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Native fixture turn finished." } } });
    return { stopReason: "end_turn" };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
process.stdin.on("end", () => { if (!stubborn) process.exit(0); });
