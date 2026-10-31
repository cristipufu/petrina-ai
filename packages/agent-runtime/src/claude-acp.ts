#!/usr/bin/env bun
// Embedded Claude Code ACP protocol translator. Translates ACP JSON-RPC stdio to
// the coordinator's installed `claude` CLI on PATH — never a bundled agent binary.

export function resolveInstalledClaudeCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  // Keep the PATH entry path (do not realpath): an npm-installed `claude` symlink
  // then runs through its own shebang rather than the SDK's JS-extension runtime guess.
  const found = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (!found) {
    throw new Error("Claude Code is not installed: no `claude` on PATH.");
  }
  return found;
}

export async function runClaudeAcp(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
  const isVersionOnly = !rawArgs.includes("--cli") && (rawArgs.includes("--version") || rawArgs.includes("-v"));
  if (!isVersionOnly) {
    process.env.CLAUDE_CODE_EXECUTABLE = resolveInstalledClaudeCli(process.env);
  }
  process.argv = [process.argv[0] ?? "petrina-engine", "claude-agent-acp", ...rawArgs];
  await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
}

if (import.meta.main) await runClaudeAcp();
