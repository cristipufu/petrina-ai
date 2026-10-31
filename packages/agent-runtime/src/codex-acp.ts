#!/usr/bin/env bun
/// <reference path="./codex-acp.d.ts" />
// Embedded Codex ACP protocol translator. Translates ACP JSON-RPC stdio to the
// coordinator's installed `codex` CLI on PATH (via Petrina's codex-background wrapper).

export function resolveInstalledCodexCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_PATH?.trim();
  if (configured) return configured;
  const found = Bun.which("codex", { PATH: env.PATH ?? "" });
  if (!found) {
    throw new Error("Codex is not installed: no `codex` on PATH.");
  }
  return found;
}

export async function runCodexAcp(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (!rawArgs.includes("--version")) {
    process.env.CODEX_PATH = resolveInstalledCodexCli(process.env);
  }
  process.argv = [process.argv[0] ?? "petrina-engine", "codex-acp", ...rawArgs];
  await import("@agentclientprotocol/codex-acp/dist/index.js");
}

if (import.meta.main) await runCodexAcp();
