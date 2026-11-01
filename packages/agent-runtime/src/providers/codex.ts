import { dirname, join } from "node:path";
import { compiledExecutableDir, isCompiledBinary } from "@petrina/platform/compiled-runtime";
import { runCodexAcp } from "../codex-acp.js";
import { BACKGROUND_FEATURES } from "../codex-background.js";
import { CODEX_USAGE_COMMAND, CodexUsage } from "../codex-usage.js";
import { steering } from "../live-input.js";
import { codexInterruptions } from "../native-provider-interruptions.js";
import { codexLimit } from "../provider-limits.js";
import { defineProviderAdapter } from "./define.js";

export const CODEX_AGENT_ENTRY = "@agentclientprotocol/codex-acp/dist/index.js";

const DEFAULT_RUNTIME_SRC_DIR = isCompiledBinary(import.meta.dir) ? import.meta.dir : dirname(import.meta.dir);

export function codexWrapperPath(
  execPath: string = process.execPath,
  metaDir: string = DEFAULT_RUNTIME_SRC_DIR,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isCompiledBinary(metaDir)) {
    return join(compiledExecutableDir(execPath), platform === "win32" ? "codex-background.cmd" : "codex-background");
  }
  return join(metaDir, "codex-background.ts");
}

export const codexAdapter = defineProviderAdapter("codex", {
  clientMeta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
  liveInput: steering(false),
  parseLimitError: codexLimit,
  interruptions: codexInterruptions,
  prepareEnv: (env) => {
    env.CODEX_CONFIG = JSON.stringify({
      ...JSON.parse(env.CODEX_CONFIG ?? "{}"),
      ...Object.fromEntries(BACKGROUND_FEATURES.map((feature) => [`features.${feature}`, false])),
    });
    env.DISABLE_MCP_CONFIG_FILTERING = "true";
    // A nested launch may inherit another working copy's wrapper. Retain its
    // real target; wrapping CODEX_PATH again would launch wrappers recursively.
    if (env.CODEX_PATH && env.CODEX_PATH !== env.PETRINA_CODEX_WRAPPER) env.PETRINA_CODEX_EXECUTABLE = env.CODEX_PATH;
    env.CODEX_PATH = env.PETRINA_CODEX_WRAPPER = codexWrapperPath();
  },
  usageReader: {
    command: () => CODEX_USAGE_COMMAND,
    create: (options) => new CodexUsage(options),
    startGapMs: 0,
  },
  entry: CODEX_AGENT_ENTRY,
  internalSubcommand: "__internal-codex-acp",
  internalSourceFile: "codex-acp.ts",
  internalRunner: runCodexAcp,
  options: { model: "model", effort: "reasoning_effort", mode: "mode" },
  // Auto review: Codex's own reviewer approves, and asks only about actions it finds unsafe.
  mode: "agent",
  login: "report",
});
