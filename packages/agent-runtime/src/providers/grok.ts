import { grokToolMetadata, grokTurnReport } from "../grok-report.js";
import { GROK_AGENT_COMMAND, GrokUsage } from "../grok-usage.js";
import { interjection } from "../live-input.js";
import { grokInterruptions } from "../native-provider-interruptions.js";
import { grokLimit } from "../provider-limits.js";
import { defineProviderAdapter } from "./define.js";

export const grokAdapter = defineProviderAdapter("grok", {
  liveInput: interjection,
  // Shared native project memory can contain another task's obsolete rules.
  // Keep this conversation's history and skills; disable only persistent memory
  // for managed runs. The installed ACP route does not honor --no-memory.
  prepareEnv: (env) => {
    env.GROK_MEMORY = "0";
  },
  parseLimitError: grokLimit,
  interruptions: grokInterruptions,
  parseTurnReport: grokTurnReport,
  toolMetadata: grokToolMetadata,
  usageReader: {
    command: () => GROK_AGENT_COMMAND,
    create: (options) => new GrokUsage(options),
  },
  // Grok is the ACP server. No Node adapter. `--permission-mode auto` outranks a saved always-approve
  // setting, which would otherwise supersede session auto mode. Never a yolo or always-approve flag.
  command: GROK_AGENT_COMMAND,
  options: { model: "model", effort: "reasoning_effort" },
  mode: "auto",
  sessionMeta: { autoMode: true },
  // Grok sends no login report: it signs in as a conversation opens (its "auth" setup step).
  login: "open",
});
