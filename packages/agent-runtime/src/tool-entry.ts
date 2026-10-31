import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compiledExecutableDir,
  findBunRuntime,
  findJsRuntime,
  isCompiledBinary,
} from "@petrina/platform/compiled-runtime";
import type { ToolAdapter } from "./tool-adapter.js";

export const CLAUDE_AGENT_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";
export const CODEX_AGENT_ENTRY = "@agentclientprotocol/codex-acp/dist/index.js";
export const GROK_AGENT_COMMAND = ["grok", "--permission-mode", "auto", "agent", "stdio"] as const;

const INTERNAL_SUBCOMMAND_SOURCE: Record<NonNullable<ToolAdapter["internalSubcommand"]>, string> = {
  "__internal-claude-acp": "claude-acp.ts",
  "__internal-codex-acp": "codex-acp.ts",
};

const INTERNAL_SUBCOMMAND_ENTRY: Record<NonNullable<ToolAdapter["internalSubcommand"]>, string> = {
  "__internal-claude-acp": CLAUDE_AGENT_ENTRY,
  "__internal-codex-acp": CODEX_AGENT_ENTRY,
};

let cachedSourceRequire: NodeRequire | undefined;

function getSourceRequire(): NodeRequire {
  cachedSourceRequire ??= createRequire(import.meta.url);
  return cachedSourceRequire;
}

export function resolveAdapterEntry(
  entry: string,
  execPath: string = process.execPath,
  metaDir: string = import.meta.dir,
): string {
  if (isCompiledBinary(metaDir)) {
    try {
      const adjacentRequire = createRequire(pathToFileURL(join(compiledExecutableDir(execPath), "package.json")).href);
      return adjacentRequire.resolve(entry);
    } catch {
      // Fall through to embedded/global resolution so missing tools surface standard module-not-found.
    }
  }
  return getSourceRequire().resolve(entry);
}

export function adapterEntry(adapter: ToolAdapter): string {
  if (!adapter.entry) throw new Error(`${adapter.name} is started by its own command`);
  return resolveAdapterEntry(adapter.entry);
}

export function adapterLaunchCommand(
  adapter: ToolAdapter,
  execPath: string = process.execPath,
  metaDir: string = import.meta.dir,
): string[] {
  if (adapter.command) return [...adapter.command];
  if (adapter.internalSubcommand) {
    if (isCompiledBinary(metaDir)) {
      return [execPath, adapter.internalSubcommand];
    }
    resolveAdapterEntry(adapter.entry ?? INTERNAL_SUBCOMMAND_ENTRY[adapter.internalSubcommand], execPath, metaDir);
    return [findBunRuntime(execPath, metaDir), join(metaDir, INTERNAL_SUBCOMMAND_SOURCE[adapter.internalSubcommand])];
  }
  return [findJsRuntime(execPath, metaDir), resolveAdapterEntry(adapter.entry ?? "", execPath, metaDir)];
}
