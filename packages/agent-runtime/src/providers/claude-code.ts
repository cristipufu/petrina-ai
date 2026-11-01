import { runClaudeAcp } from "../claude-acp.js";
import { claudeBackground } from "../claude-background.js";
import { CLAUDE_USAGE_COMMAND, ClaudeUsage } from "../claude-usage.js";
import { claudeReports } from "../claude-usage-report.js";
import { steering } from "../live-input.js";
import { claudeInterruptions } from "../native-provider-interruptions.js";
import { claudeLimit } from "../provider-limits.js";
import { askMode } from "../claude-ask-mode.js";
import { defineProviderAdapter } from "./define.js";

export const CLAUDE_AGENT_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";

export const claudeCodeAdapter = defineProviderAdapter("claude-code", {
  liveInput: steering(true),
  parseLimitError: claudeLimit,
  interruptions: claudeInterruptions,
  parseUsageUpdate: (meta) => ({
    reports: claudeReports("claude-code", meta),
    ...(typeof meta["_claude/model"] === "string" ? { model: meta["_claude/model"] } : {}),
  }),
  reconcilesAllowanceWindows: true,
  prepareSessionMeta: async (meta, { cwd, browser }) => {
    if (!browser) return meta;
    const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined;
    return { ...meta, claudeCode: { ...claude, options: { ...claude?.options, ...(await claudeBackground(cwd)) } } };
  },
  usageReader: {
    command: () => CLAUDE_USAGE_COMMAND,
    create: (options) => new ClaudeUsage(options),
  },
  entry: CLAUDE_AGENT_ENTRY,
  internalSubcommand: "__internal-claude-acp",
  internalSourceFile: "claude-acp.ts",
  internalRunner: runClaudeAcp,
  options: { model: "model", effort: "effort", mode: "mode" },
  // Auto: Claude Code's own classifier makes the permission decisions.
  mode: "auto",
  login: "report",
  // The adapter hands `_meta.claudeCode.options` to Claude Code as its own settings.
  sandboxMeta: (sandbox) => ({ claudeCode: { options: { sandbox } } }),
  resolveTerminalMode: (path) => askMode(path),
});
