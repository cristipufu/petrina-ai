import { createRequire } from "node:module";
import type { AgentProfile, Tool } from "@petrina/core";
import type { ClaudeSandbox } from "./sandbox.js";
import { antigravityCommand, antigravityInstalled, forgetAntigravityProbe } from "./antigravity-runtime.js";

/** How Petrina drives one tool through ACP. */
export interface ToolAdapter {
  id: string;
  name: string;
  /** The adapter's entry point, resolved from node_modules. Unset when `command` is the agent itself. */
  entry?: string;
  /** The program to spawn when the agent is the ACP server. Otherwise Petrina runs `node` on `entry`. */
  command?: readonly string[];
  /** The CLI the tool needs on PATH, for detection and for taking over in a terminal. */
  cli: string;
  /** Additional native runtime needed alongside the terminal CLI. */
  installed?: () => boolean;
  /** Forget a disposable identity/account probe, only after its process has stopped. */
  forgetProbe?: (sessionId: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Session config option ids the adapter exposes. `mode` is unset when the mode is session metadata instead. */
  options: { model: string; effort: string; mode?: string };
  /** The tool's own working mode; permission requests still reach the coordinator. */
  mode: string;
  /** Sent on `session/new`, `session/resume` and `session/load`. Grok's auto mode lives here, not in a config option. */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * How the tool says whether it is logged in, without a message to the AI. "report": its connector sends
   * the login it runs on (`_auth/status_update`), and opens conversations either way. "open": it checks its
   * login as a conversation opens and refuses with ACP's "log in first" error when there is none, so a
   * conversation that opens is its own word.
   */
  login: "report" | "open";
  models: readonly string[];
  /**
   * The session option that carries Claude Code's own sandbox settings to its adapter. Unset: the
   * tool keeps its own setup (including Codex's workspace sandbox) and gets no sandbox settings from Petrina.
   */
  sandboxMeta?: (sandbox: ClaudeSandbox) => Record<string, unknown>;
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
    login: "report",
    models: ["Opus 5.5", "Fable 5.1", "Sonnet 5.5"],
    // The adapter hands `_meta.claudeCode.options` to Claude Code as its own settings.
    sandboxMeta: (sandbox) => ({ claudeCode: { options: { sandbox } } }),
  },
  codex: {
    id: "codex",
    name: "Codex",
    entry: "@agentclientprotocol/codex-acp/dist/index.js",
    cli: "codex",
    options: { model: "model", effort: "reasoning_effort", mode: "mode" },
    // Auto review: Codex's own reviewer approves, and asks only about actions it finds unsafe.
    mode: "agent",
    login: "report",
    models: ["sol", "astra"],
  },
  grok: {
    id: "grok",
    name: "Grok",
    cli: "grok",
    // Grok is the ACP server. No Node adapter. `--permission-mode auto` outranks a saved always-approve
    // setting, which would otherwise supersede session auto mode. Never a yolo or always-approve flag.
    command: ["grok", "--permission-mode", "auto", "agent", "stdio"],
    options: { model: "model", effort: "reasoning_effort" },
    mode: "auto",
    sessionMeta: { autoMode: true },
    // Grok sends no login report: it signs in as a conversation opens (its "auth" setup step).
    login: "open",
    models: ["Grok 4.7"],
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    cli: "agy",
    get command() { return antigravityCommand(); },
    installed: antigravityInstalled,
    forgetProbe: forgetAntigravityProbe,
    options: { model: "model", effort: "thinking_level", mode: "mode" },
    // Google's ACP server offers edit approval, but no CLI Auto classifier. Commands still ask.
    mode: "auto_edit",
    login: "open",
    models: ["Gemini 4 Argon", "Gemini 3.8 Flash"],
  },
};

/**
 * The profiles the real engine offers. The planner may choose any of them except Sonnet, which works
 * only as a stand-in. Grok comes after Codex, so a stand-in still prefers Codex while Codex has a seat.
 */
export const ENGINE_PROFILES: readonly AgentProfile[] = [
  { id: "opus-xhigh", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "xhigh" },
  { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
  { id: "sol-xhigh", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh" },
  { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
  { id: "grok-xhigh", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "xhigh" },
  { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" },
  { id: "argon-high", toolId: "antigravity", model: "Gemini 4 Argon", modelId: "gemini-4-argon", effort: "high" },
  { id: "argon-medium", toolId: "antigravity", model: "Gemini 4 Argon", modelId: "gemini-4-argon", effort: "medium" },
  { id: "flash-high", toolId: "antigravity", model: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash", effort: "high" },
  { id: "flash-medium", toolId: "antigravity", model: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash", effort: "medium" },
  { id: "fable-xhigh", toolId: "claude-code", model: "Fable 5.1", modelId: "fable", effort: "xhigh" },
  { id: "astra-xhigh", toolId: "codex", model: "astra", modelId: "gpt-6-astra", effort: "xhigh" },
  // Works only when Opus is out of usage and Claude Code is not (its weekly Opus limit); never planned.
  { id: "sonnet-high", toolId: "claude-code", model: "Sonnet 5.5", modelId: "sonnet", effort: "high", standby: true },
];

const require = createRequire(import.meta.url);

export function adapterEntry(adapter: ToolAdapter): string {
  if (!adapter.entry) throw new Error(`${adapter.name} is started by its own command`);
  return require.resolve(adapter.entry);
}

/**
 * Where a program is on the PATH as it is now, or null. Bun.which reads the PATH the process started
 * with unless told otherwise; app mode merges in the login shell's PATH later, so a Petrina opened
 * from the Dock still finds what Terminal finds. The Library and first run's checks both look here.
 */
export function findProgram(name: string): string | null {
  return Bun.which(name, { PATH: process.env.PATH ?? "" });
}

/** Which tools are usable on this machine: the CLI is installed and the adapter resolves. */
export function detectTools(): Tool[] {
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
    const installed = resolved && findProgram(adapter.cli) !== null && (adapter.installed?.() ?? true);
    return {
      id: adapter.id,
      name: adapter.name,
      command: adapter.command ? [...adapter.command] : ["node", adapter.entry ?? adapter.cli],
      status: installed ? "ready" : "not-installed",
      models: adapter.models,
    };
  });
}
