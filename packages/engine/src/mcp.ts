// MCP stdio: only JSON-RPC messages go to stdout. No engine is constructed in this process.
import { createInterface } from "node:readline";
import { z } from "zod";
import { EngineClient } from "./engine-client.js";
import { OPERATIONS } from "./operations.js";
const toolName = (name: string) => `petrina_${name.replace(/[.-]/g, "_")}`;
export const mcpTools = () =>
  OPERATIONS.map((op) => ({
    name: toolName(op.name),
    description: op.description,
    inputSchema: z.toJSONSchema(op.schema),
    outputSchema: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"], additionalProperties: true },
    // Changes can replace settings, interrupt work and authorize publishing. Do not claim
    // additive-only effects or a closed system to the calling agent's safety checker.
    annotations: { readOnlyHint: !op.changes, idempotentHint: op.changes },
  }));
export async function mcpRequest(message: Record<string, any>, client: EngineClient): Promise<Record<string, unknown> | undefined> {
  const id = message.id;
  if (id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  if (message.method === "initialize")
    return reply({
      protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "petrina", version: "0.1.0" },
      instructions:
        "Coordinate the existing local Petrina engine. Inspect requests before decisions and return their revision. Save a requestId before every change and reuse it after a lost reply. Connecting does not launch an engine. Source editing, Git, development tests and product repairs belong to normal coding tools. Petrina never merges pull requests.",
    });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") return reply({ tools: mcpTools() });
  if (message.method === "tools/call") {
    const op = OPERATIONS.find((op) => toolName(op.name) === message.params?.name);
    if (!op) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown Petrina tool. Use tools/list." } };
    const result = await client.call(op.name, message.params?.arguments ?? {});
    return reply({
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: !["completed", "pending", "timed-out"].includes(result.outcome),
    });
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}
export async function runMcp(client = new EngineClient()): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const active = new Set<Promise<void>>();
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  for await (const line of lines) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    const work = mcpRequest(message, client)
      .then(
        (result) => {
          if (result) send(result);
        },
        () => {
          send({
            jsonrpc: "2.0",
            id: message.id ?? null,
            error: { code: -32603, message: "The coordination request failed. Retry changes with the original request reference." },
          });
        },
      )
      .finally(() => active.delete(work));
    active.add(work);
  }
  // Ending an MCP connection ends its waits, never the work in the engine.
  if (active.size) process.exit(0);
}
