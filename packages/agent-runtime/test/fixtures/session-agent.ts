// Native ACP peer for lifecycle and launch contracts. It has no workflow roles, Git, accounts or Engine.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import type { NativePlan } from "./native-session.js";
import { protocolActions, type NativePrompt, type ProtocolHistory } from "./protocol-actions.js";

const root = process.argv.find(value => value.startsWith("--peer-root="))?.slice("--peer-root=".length) ?? process.cwd();
const planFile = join(root, ".native-peer.json");
const plan = (): NativePlan => existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : {};
const requested = (method: string, params?: unknown) => { if (plan().recordRequests) appendFileSync(join(root, ".native-requests.jsonl"), `${JSON.stringify({ method, params, pid: process.pid })}\n`); };

const stubborn = process.argv.includes("--stubborn");
if (stubborn) { process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); }
const select = (id: string, values: string[]): acp.SessionConfigOption => ({ type: "select", id, name: id, currentValue: values[0]!, options: values.map(value => ({ value, name: value })) });
const options = () => plan().config ?? [
  select("model", ["default", "opus", "gpt-6.1-sol", "grok-4.7"]),
  select("effort", ["high", "xhigh"]),
  select("reasoning_effort", ["low", "medium", "high", "xhigh", "ultra"]),
  select("thinking_level", ["low", "medium", "high"]),
  select("mode", ["default", "auto", "agent", "auto_edit", "yolo"]),
];
const record = join(root, ".native-sessions.json");
interface Session extends ProtocolHistory { options: acp.SessionConfigOption[]; counts?: Record<string, number> }
const sessions = new Map<string, Session>(existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : []);
const keep = () => writeFixtureJson(record, [...sessions]);
const session = (id: string) => { const current = sessions.get(id); if (!current) throw acp.RequestError.invalidParams("Fixture session not found"); return current; };
const sessionOptions = (id: string) => session(id).options;
acp.agent({ name: "native session fixture" })
  .onRequest("initialize", ctx => {
    requested("initialize", ctx.params);
    if (plan().recordEnvironment) writeFixtureJson(join(root, ".native-environment.json"), process.env);
    if (plan().recordInitialize) appendFileSync(join(root, "initialize.jsonl"), `${JSON.stringify(ctx.params)}\n`);
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: plan().reopen === "load" ? { loadSession: true } : { sessionCapabilities: { resume: {} } } };
  })
  .onRequest("session/new", async ctx => {
    requested("session/new", ctx.params);
    if (process.argv.includes("--logged-out")) throw acp.RequestError.authRequired();
    if (process.argv.includes("--hang")) await new Promise(() => undefined);
    const sessionId = crypto.randomUUID();
    const configOptions = options();
    sessions.set(sessionId, { options: configOptions, history: [], notices: [] }); keep();
    return { sessionId, configOptions };
  })
  .onRequest("session/resume", ctx => { requested("session/resume", ctx.params); return { configOptions: sessionOptions(ctx.params.sessionId) }; })
  .onRequest("session/load", async ctx => {
    requested("session/load", ctx.params);
    const current = session(ctx.params.sessionId);
    for (const update of current.history) await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    for (const notice of current.notices) await ctx.client.notify(notice.method as typeof acp.methods.client.session.update, notice.params as never);
    return { configOptions: current.options };
  })
  .onRequest("session/set_config_option", ctx => {
    requested("session/set_config_option", ctx.params);
    const configOptions = sessionOptions(ctx.params.sessionId);
    const option = configOptions.find(option => option.id === ctx.params.configId);
    if (option?.type !== "select" || typeof ctx.params.value !== "string" || !option.options.some(choice => "value" in choice && choice.value === ctx.params.value)) throw acp.RequestError.invalidParams("Fixture setting not supported");
    option.currentValue = ctx.params.value; keep();
    return { configOptions };
  })
  .onRequest("session/prompt", async ctx => {
    const current = session(ctx.params.sessionId);
    const text = ctx.params.prompt.map(part => part.type === "text" ? part.text : "").join("\n");
    requested("session/prompt", { sessionId: ctx.params.sessionId, text });
    const counts = current.counts ??= {}, index = counts[text] ?? 0;
    counts[text] = index + 1; keep();
    const named = plan().prompts?.[text];
    const selected = Array.isArray(named) ? named[index] : named;
    if (plan().prompts && !text.startsWith("NATIVE-STEPS ") && !selected) throw acp.RequestError.invalidParams(`Unexpected native fixture input: ${text}`);
    const script: NativePrompt = text.startsWith("NATIVE-STEPS ") ? JSON.parse(text.slice("NATIVE-STEPS ".length)) : selected ?? plan().prompt ?? { steps: [], reply: "Native fixture turn finished." };
    await protocolActions(ctx.client, ctx.params.sessionId, script.steps, current, keep);
    if (script.reply) await protocolActions(ctx.client, ctx.params.sessionId, [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: script.reply } } }], current, keep);
    if (script.late) setTimeout(() => { void protocolActions(ctx.client, ctx.params.sessionId, script.late!, current, keep).catch(() => undefined); }, 0);
    return { stopReason: script.stopReason ?? "end_turn", ...(script.usage ? { usage: script.usage } : {}), ...(script.meta ? { _meta: script.meta } : {}) };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
process.stdin.on("end", () => { if (!stubborn) process.exit(0); });
