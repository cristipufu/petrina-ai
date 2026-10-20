import { createRequire } from "node:module";
import type { AgentProfile, Tool } from "@petrina/core";
import type { ToolAdapter } from "./tool-adapter.js";
export type { ToolAdapter } from "./tool-adapter.js";
import { join } from "node:path";
import { claudeBackground } from "./claude-background.js";
import { BACKGROUND_FEATURES } from "./codex-background.js";
import { claudeReports } from "./claude-usage-report.js";
import { claudeLimit, codexLimit, grokLimit } from "./provider-limits.js";
import { CODEX_USAGE_COMMAND, CodexUsage } from "./codex-usage.js";
import { GrokUsage, grokTurnReport } from "./grok-usage.js";
import { AntigravityUsage } from "./antigravity-usage.js";
import { antigravityReading, antigravityTurnReport } from "./antigravity-report.js";
import { antigravityCommand, antigravityInstalled, forgetAntigravityProbe } from "./antigravity-runtime.js";

export const ADAPTERS: Readonly<Record<string, ToolAdapter>> = {
  "claude-code": {
    parseLimitError: claudeLimit,
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
    parseLimitError: codexLimit,
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
    parseLimitError: grokLimit,
    parseTurnReport: grokTurnReport,
    toolMetadata: meta => {
      const value = meta["x.ai/tool"];
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    },
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
