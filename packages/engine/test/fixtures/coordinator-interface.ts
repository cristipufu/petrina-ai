import { expect } from "bun:test";
import { EngineClient } from "../client.js";
import { coordinationCli } from "../../src/coordination-cli.js";
import { mcpRequest } from "../../src/mcp.js";
import type { Result } from "../../src/coordination.js";

/** In-process CLI parser over HTTP client or MCP-to-HTTP client; neither can silently start another engine. */
export function interfaceClient(kind: "cli" | "mcp", home: string) {
  const client = new EngineClient(home, () => { throw new Error("coordination cannot launch"); });
  return async (name: string, args: Record<string, unknown>, expectedCode = 0): Promise<Result> => {
    if (kind === "mcp") {
      const response = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `petrina_${name.replaceAll(".", "_")}`, arguments: args } }, client);
      const result = response!.result as { isError: boolean; structuredContent: Result };
      expect(result.isError).toBe(expectedCode !== 0);
      return result.structuredContent;
    }
    const argv = name.split(".");
    for (const [key, value] of Object.entries(args)) argv.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, typeof value === "string" ? value : JSON.stringify(value));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await coordinationCli([...argv, "--json"], client, {
      log: (line) => { stdout.push(line); },
      error: (line) => { stderr.push(line); },
    });
    expect(code, stderr.join("\n")).toBe(expectedCode);
    return JSON.parse(stdout.join("\n"));
  };
}
