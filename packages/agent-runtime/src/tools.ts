import type { AgentProfile, Tool } from "@petrina/core";
import { ADAPTERS as CATALOG_ADAPTERS } from "./providers/index.js";
import type { ToolAdapter } from "./tool-adapter.js";
export type { ToolAdapter } from "./tool-adapter.js";
import { adapterLaunchCommand } from "./tool-entry.js";
export { adapterEntry, adapterLaunchCommand } from "./tool-entry.js";

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

export function agentCommandFor(
  options: AgentLaunchOptions,
  profile: AgentProfile,
): readonly string[] | undefined {
  const command = options.agentCommand?.(profile);
  if (options.requireAgentCommand && !command?.length) {
    throw new Error(
      `This test must supply a scripted agent command for ${profile.toolId}; native agent fallback is disabled.`,
    );
  }
  return command;
}

/** Which tools are usable on this machine: the CLI is installed and the adapter resolves. */
export function detectTools(available?: (toolId: string) => boolean): Tool[] {
  return Object.values(ADAPTERS).map((adapter) => {
    let launchCommand: string[] | undefined;
    try {
      launchCommand = adapterLaunchCommand(adapter);
    } catch {
      launchCommand = undefined;
    }
    const resolved = launchCommand !== undefined;
    const installed = available ? available(adapter.id) : resolved && findProgram(adapter.cli) !== null;
    return {
      id: adapter.id,
      name: adapter.name,
      command: launchCommand ?? [adapter.cli],
      status: installed ? "ready" : "not-installed",
      models: adapter.models,
    };
  });
}
