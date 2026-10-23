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
/**
 * Pending tool calls by request id, so a cancellation notification can end the matching wait. JSON-RPC ids
 * keep their type: the number 7 and the text "7" are different requests and never share a slot.
 */
export class McpPending {
  private readonly controllers = new Map<string, AbortController>();
  private key(id: unknown): string { return `${typeof id}:${String(id)}`; }
  open(id: unknown): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(this.key(id), controller);
    return controller.signal;
  }
  /** The request finished: forget it, unless a later request with the same id has taken its place. */
  close(id: unknown, signal?: AbortSignal): void {
    const key = this.key(id);
    if (!signal || this.controllers.get(key)?.signal === signal) this.controllers.delete(key);
  }
  /** True when a request with that id was still pending. A completed request is left alone. */
  cancel(id: unknown): boolean {
    const key = this.key(id);
    const controller = this.controllers.get(key);
    if (!controller) return false;
    this.controllers.delete(key);
    controller.abort();
    return true;
  }
  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
  get size(): number { return this.controllers.size; }
}

export async function mcpRequest(message: Record<string, any>, client: EngineClient, pending?: McpPending): Promise<Record<string, unknown> | undefined> {
  const id = message.id;
  if (message.method === "notifications/cancelled") {
    pending?.cancel(message.params?.requestId);
    return undefined;
  }
  if (id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  if (message.method === "initialize")
    return reply({
      protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "petrina", version: "0.1.0" },
      instructions:
        "Coordinate the existing local Petrina engine. Inspect requests before decisions and return their revision. Save a requestId before every change and reuse it after a lost reply. Connecting does not launch an engine. Source editing, Git, development tests and product repairs belong to normal coding tools. Petrina never merges pull requests. Required extra full-suite validation uses validation.run with a request reference and a prepared local Linux image, sharing the check queue; never pause the pool or poll for room. It tests only Petrina's last saved commit/tree, excluding working edits: hand new work back first. No native, remote or detached extra execution. Focused tests and image preparation remain coding-tool work. Extra evidence never replaces configured full checks. Product removal is refused while an extra run still needs cleanup ownership; held cleanup needs the container service available or the named container stopped.",
    });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") return reply({ tools: mcpTools() });
  if (message.method === "tools/call") {
    const op = OPERATIONS.find((op) => toolName(op.name) === message.params?.name);
    if (!op) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown Petrina tool. Use tools/list." } };
    const signal = pending?.open(id);
    let result: import("./coordination.js").Result;
    try { result = await client.call(op.name, message.params?.arguments ?? {}, signal ? { signal } : {}); }
    finally { pending?.close(id, signal); }
    // A cancelled request gets no reply: the client stopped waiting, and the engine wait is already released.
    if (signal?.aborted) return undefined;
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
  const pending = new McpPending();
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  for await (const line of lines) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    const work = mcpRequest(message, client, pending)
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
  pending.cancelAll();
  if (active.size) process.exit(0);
}
