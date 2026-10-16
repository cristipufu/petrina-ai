import { createRequire } from "node:module";
import type { AgentProfile, Tool } from "@petrina/core";

/** How Petrina drives one tool through its ACP adapter. */
export interface ToolAdapter {
  id: string;
  name: string;
  /** The adapter's entry point, resolved from node_modules. */
  entry: string;
  /** The CLI the adapter needs on PATH. */
  cli: string;
  /** Session config option ids the adapter exposes. */
  options: { model: string; effort: string; mode: string };
  /** The tool's own automatic safety mode: its checker decides, and only what it flags reaches the coordinator. */
  mode: string;
  models: readonly string[];
}

export const ADAPTERS: Readonly<Record<string, ToolAdapter>> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    entry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    cli: "claude",
    options: { model: "model", effort: "effort", mode: "mode" },
    // Auto: Claude Code's own classifier makes the permission decisions.
    mode: "auto",
    models: ["Opus 5.5"],
  },
  codex: {
    id: "codex",
    name: "Codex",
    entry: "@agentclientprotocol/codex-acp/dist/index.js",
    cli: "codex",
    options: { model: "model", effort: "reasoning_effort", mode: "mode" },
    // Auto review: Codex's own reviewer approves, and asks only about actions it finds unsafe.
    mode: "agent",
    models: ["sol"],
  },
};

/**
 * The only profiles the real engine offers: Opus and sol, at high or xhigh effort.
 * The planner may only choose among these.
 */
export const ENGINE_PROFILES: readonly AgentProfile[] = [
  { id: "opus-xhigh", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "xhigh" },
  { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
  { id: "sol-xhigh", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh" },
  { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
];

const require = createRequire(import.meta.url);

export function adapterEntry(adapter: ToolAdapter): string {
  return require.resolve(adapter.entry);
}

/** Which tools are usable on this machine: the CLI is installed and the adapter resolves. */
export function detectTools(): Tool[] {
  return Object.values(ADAPTERS).map((adapter) => {
    let resolved = true;
    try {
      adapterEntry(adapter);
    } catch {
      resolved = false;
    }
    const installed = resolved && Bun.which(adapter.cli) !== null;
    return {
      id: adapter.id,
      name: adapter.name,
      command: ["node", adapter.entry],
      status: installed ? "ready" : "not-installed",
      models: adapter.models,
    };
  });
}
