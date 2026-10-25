// Grok's read-only ACP account endpoint; deliberately no session or prompt handler.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2]!;
let buffer = "";
const send = (id: number, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  for (let at; (at = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    appendFileSync(join(dir, "requests.jsonl"), JSON.stringify({ pid: process.pid, method: message.method }) + "\n");
    const plan = JSON.parse(readFileSync(join(dir, "billing.json"), "utf8"));
    if (plan.ignoreStop) process.on("SIGTERM", () => undefined);
    if (message.method === "initialize") send(message.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (message.method === "_x.ai/billing") {
      if (plan.hang) continue;
      if (plan.error) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: plan.error } }) + "\n");
      else send(message.id, plan);
    } else throw new Error(`An account read must not call ${message.method}`);
  }
});
process.stdin.on("end", () => process.exit(0));
