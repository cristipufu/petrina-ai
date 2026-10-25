// A native ACP login peer: no workflow, model responses, repository or account access.
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
const [root, login] = process.argv.slice(2);
if (!root || !["none", "silent"].includes(login ?? "")) throw new Error("A private login script is required");
const log = (name: string, value: unknown) => appendFileSync(join(root, name), `${JSON.stringify(value)}\n`);
acp.agent({ name: "readiness fixture" })
  .onRequest("initialize", async ctx => {
    if (login !== "silent") setImmediate(() => void ctx.client.notify("_auth/status_update", { authStatus: { kind: login, label: "Fixture login" } }).catch(() => undefined));
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  })
  .onRequest("session/new", ctx => { const sessionId = crypto.randomUUID(); log("opens.jsonl", { session: sessionId, cwd: ctx.params.cwd }); return { sessionId, configOptions: [] }; })
  .onRequest("session/prompt", ctx => { log("prompts.jsonl", ctx.params); throw new Error("A readiness probe sent model work"); })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
process.stdin.on("end", () => process.exit(0));
