import { grokToolMetadata } from "./grok-report.js";
import { createRequire } from "node:module";
import type { AgentProfile, Tool } from "@petrina/core";
import type { ToolAdapter } from "./tool-adapter.js";
export type { ToolAdapter } from "./tool-adapter.js";
import { join } from "node:path";
import { claudeBackground } from "./claude-background.js";
import { BACKGROUND_FEATURES } from "./codex-background.js";
import { claudeReports } from "./claude-usage-report.js";
import { CLAUDE_USAGE_COMMAND, ClaudeUsage } from "./claude-usage.js";
import { claudeLimit, codexLimit, grokLimit } from "./provider-limits.js";
import { claudeInterruptions, codexInterruptions, grokInterruptions } from "./native-provider-interruptions.js";
import { CODEX_USAGE_COMMAND, CodexUsage } from "./codex-usage.js";
import { GrokUsage } from "./grok-usage.js";
import { grokTurnReport } from "./grok-report.js";
import { AntigravityUsage } from "./antigravity-usage.js";
import { antigravityReading, antigravityTurnReport } from "./antigravity-report.js";
import { antigravityCommand, antigravityInstalled, forgetAntigravityProbe } from "./antigravity-runtime.js";
import { interjection, steering } from "./live-input.js";

export const ADAPTERS: Readonly<Record<string, ToolAdapter>> = {
  "claude-code": {
    usageReader: { command: () => CLAUDE_USAGE_COMMAND, create: options => new ClaudeUsage(options) },
    liveInput: steering(true),
    parseLimitError: claudeLimit,
    interruptions: claudeInterruptions,
    parseUsageUpdate: meta => ({ reports: claudeReports("claude-code", meta), ...(typeof meta["_claude/model"] === "string" ? { model: meta["_claude/model"] } : {}) }),
    prepareSessionMeta: async (meta, { cwd, browser }) => {
      if (!browser) return meta;
      const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined;
      return { ...meta, claudeCode: { ...claude, options: { ...claude?.options, ...await claudeBackground(cwd) } } };
    },
    terminalArgs: ({ session, model, effort, mode }) => ["--resume", session, "--model", model, "--effort", effort, "--permission-mode", mode],
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
    clientMeta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
    liveInput: steering(false),
    parseLimitError: codexLimit,
    interruptions: codexInterruptions,
    prepareEnv: env => {
      env.CODEX_CONFIG = JSON.stringify({ ...JSON.parse(env.CODEX_CONFIG ?? "{}"), ...Object.fromEntries(BACKGROUND_FEATURES.map(feature => [`features.${feature}`, false])) });
      env.DISABLE_MCP_CONFIG_FILTERING = "true";
      // A nested launch may inherit another working copy's wrapper. Retain its
      // real target; wrapping CODEX_PATH again would launch wrappers recursively.
      if (env.CODEX_PATH && env.CODEX_PATH !== env.PETRINA_CODEX_WRAPPER) env.PETRINA_CODEX_EXECUTABLE = env.CODEX_PATH;
      env.CODEX_PATH = env.PETRINA_CODEX_WRAPPER = join(import.meta.dir, "codex-background.ts");
    },
    usageReader: { command: () => CODEX_USAGE_COMMAND, create: options => new CodexUsage(options), startGapMs: 0 },
    terminalArgs: ({ session, model, effort }) => ["resume", session, "--model", model, "-c", `model_reasoning_effort=${effort}`, "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"],
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
    liveInput: interjection,
    // Shared native project memory can contain another task's obsolete rules.
    // Keep this conversation's history and skills; disable only persistent memory
    // for managed runs. The installed ACP route does not honor --no-memory.
    prepareEnv: env => { env.GROK_MEMORY = "0"; },
    parseLimitError: grokLimit,
    interruptions: grokInterruptions,
    parseTurnReport: grokTurnReport,
    toolMetadata: grokToolMetadata,
    usageReader: { command: () => ADAPTERS.grok!.command!, create: options => new GrokUsage(options) },
    terminalArgs: ({ session, model, effort }) => ["--resume", session, "--model", model, "--effort", effort],
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
    verifySessionSettings: (profile, settings) => {
      if (settings.model !== profile.modelId || settings.effort !== profile.effort) throw new Error(`Antigravity did not confirm ${profile.model} with ${profile.effort} thinking. Check the models available to your Google account.`);
    },
    accountUsage: { command: "/usage", parse: antigravityReading, turnReport: antigravityTurnReport },
    usageReader: { command: antigravityCommand, create: options => new AntigravityUsage(options), liveSession: true },
    id: "antigravity",
    name: "Antigravity",
    cli: "agy",
    get command() { return antigravityCommand(); },
    installed: antigravityInstalled,
    forgetProbe: forgetAntigravityProbe,
    options: { model: "model", effort: "thinking_level", mode: "mode" },
    // The coordinator wants unattended tool use. Google's ACP server has no selective CLI Auto mode.
    mode: "yolo",
    login: "open",
    models: ["Gemini 4 Argon", "Gemini 3.8 Flash"],
  },
};

/**
 * The profiles the real engine offers. The planner may choose any of them except Sonnet, which works
 * only as a stand-in. Grok comes after Codex, so a stand-in still prefers Codex while Codex has a seat.
 */
export { DEFAULT_PROFILES as ENGINE_PROFILES } from "@petrina/core";

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
