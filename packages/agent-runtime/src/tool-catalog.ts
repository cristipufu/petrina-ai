import { join } from "node:path";
import type { ToolAdapter } from "./tool-adapter.js";
import { grokToolMetadata, grokTurnReport } from "./grok-report.js";
import { claudeTerminalArguments, codexTerminalArguments, grokTerminalArguments } from "./terminal-arguments.js";
import { claudeBackground } from "./claude-background.js";
import { BACKGROUND_FEATURES } from "./codex-background.js";
import { claudeReports } from "./claude-usage-report.js";
import { claudeLimit, codexLimit, grokLimit } from "./provider-limits.js";
import { claudeInterruptions, codexInterruptions, grokInterruptions } from "./native-provider-interruptions.js";
import { antigravityReading, antigravityTurnReport } from "./antigravity-report.js";
import { antigravityCommand, antigravityInstalled, forgetAntigravityProbe } from "./antigravity-runtime.js";
import { interjection, steering } from "./live-input.js";
import { CLAUDE_AGENT_ENTRY, CODEX_AGENT_ENTRY, GROK_AGENT_COMMAND } from "./tool-entry.js";

export const ADAPTERS: Record<string, ToolAdapter> = {
  "claude-code": {
    liveInput: steering(true),
    parseLimitError: claudeLimit,
    interruptions: claudeInterruptions,
    parseUsageUpdate: meta => ({ reports: claudeReports("claude-code", meta), ...(typeof meta["_claude/model"] === "string" ? { model: meta["_claude/model"] } : {}) }),
    prepareSessionMeta: async (meta, { cwd, browser }) => {
      if (!browser) return meta;
      const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined;
      return { ...meta, claudeCode: { ...claude, options: { ...claude?.options, ...await claudeBackground(cwd) } } };
    },
    terminalArgs: claudeTerminalArguments,
    id: "claude-code",
    name: "Claude Code",
    entry: CLAUDE_AGENT_ENTRY,
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
    terminalArgs: codexTerminalArguments,
    id: "codex",
    name: "Codex",
    entry: CODEX_AGENT_ENTRY,
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
    terminalArgs: grokTerminalArguments,
    id: "grok",
    name: "Grok",
    cli: "grok",
    // Grok is the ACP server. No Node adapter. `--permission-mode auto` outranks a saved always-approve
    // setting, which would otherwise supersede session auto mode. Never a yolo or always-approve flag.
    command: GROK_AGENT_COMMAND,
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
