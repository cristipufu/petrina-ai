import type { AgentProfile, Tool } from "@petrina/core";
import type { ToolAdapter } from "./tool-adapter.js";
export type { ToolAdapter } from "./tool-adapter.js";
import { CLAUDE_USAGE_COMMAND, ClaudeUsage } from "./claude-usage.js";
import { CODEX_USAGE_COMMAND, CodexUsage } from "./codex-usage.js";
import { GrokUsage } from "./grok-usage.js";
import { AntigravityUsage } from "./antigravity-usage.js";
import { antigravityCommand } from "./antigravity-runtime.js";
import { ADAPTERS as CATALOG_ADAPTERS } from "./tool-catalog.js";
import { adapterEntry, GROK_AGENT_COMMAND } from "./tool-entry.js";
export { adapterEntry } from "./tool-entry.js";

CATALOG_ADAPTERS["claude-code"]!.usageReader ??= {
  command: () => CLAUDE_USAGE_COMMAND,
  create: options => new ClaudeUsage(options),
};
CATALOG_ADAPTERS.codex!.usageReader ??= {
  command: () => CODEX_USAGE_COMMAND,
  create: options => new CodexUsage(options),
  startGapMs: 0,
};
CATALOG_ADAPTERS.grok!.usageReader ??= {
  command: () => GROK_AGENT_COMMAND,
  create: options => new GrokUsage(options),
};
CATALOG_ADAPTERS.antigravity!.usageReader ??= {
  command: antigravityCommand,
  create: options => new AntigravityUsage(options),
  liveSession: true,
};

export const ADAPTERS: Readonly<Record<string, ToolAdapter>> = CATALOG_ADAPTERS;

/**
 * The profiles the real engine offers. The planner may choose any of them except Sonnet, which works
 * only as a stand-in. Grok comes after Codex, so a stand-in still prefers Codex while Codex has a seat.
 */
export { DEFAULT_PROFILES as ENGINE_PROFILES } from "@petrina/core";

/**
 * Where a program is on the PATH as it is now, or null. Bun.which reads the PATH the process started
 * with unless told otherwise; app mode merges in the login shell's PATH later, so a Petrina opened
 * from the Dock still finds what Terminal finds. The Library and first run's checks both look here.
 */
export function findProgram(name: string): string | null {
  return Bun.which(name, { PATH: process.env.PATH ?? "" });
}

/** One command boundary for turns, probes and auxiliary agents; fixture mode never falls back to a native tool. */
export interface AgentLaunchOptions {
  agentCommand?: (profile: AgentProfile) => readonly string[] | undefined;
  requireAgentCommand?: boolean;
}

export function agentCommandFor(options: AgentLaunchOptions, profile: AgentProfile): readonly string[] | undefined {
  const command = options.agentCommand?.(profile);
  if (options.requireAgentCommand && !command?.length) throw new Error(`This test must supply a scripted agent command for ${profile.toolId}; native agent fallback is disabled.`);
  return command;
}

/** Which tools are usable on this machine: the CLI is installed and the adapter resolves. */
export function detectTools(available?: (toolId: string) => boolean): Tool[] {
  return Object.values(ADAPTERS).map((adapter) => {
    let resolved = adapter.command !== undefined;
    if (!resolved) {
      try {
        adapterEntry(adapter);
        resolved = true;
      } catch {
        resolved = false;
      }
    }
    const installed = available ? available(adapter.id) : resolved && findProgram(adapter.cli) !== null && (adapter.installed?.() ?? true);
    return {
      id: adapter.id,
      name: adapter.name,
      command: adapter.command ? [...adapter.command] : ["node", adapter.entry ?? adapter.cli],
      status: installed ? "ready" : "not-installed",
      models: adapter.models,
    };
  });
}
