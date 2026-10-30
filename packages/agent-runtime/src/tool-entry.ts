import { createRequire } from "node:module";
import type { ToolAdapter } from "./tool-adapter.js";

export const CLAUDE_AGENT_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";
export const CODEX_AGENT_ENTRY = "@agentclientprotocol/codex-acp/dist/index.js";
export const GROK_AGENT_COMMAND = ["grok", "--permission-mode", "auto", "agent", "stdio"] as const;

const require = createRequire(import.meta.url);

export function resolveAdapterEntry(entry: string): string {
  return require.resolve(entry);
}

export function adapterEntry(adapter: ToolAdapter): string {
  if (!adapter.entry) throw new Error(`${adapter.name} is started by its own command`);
  return resolveAdapterEntry(adapter.entry);
}
