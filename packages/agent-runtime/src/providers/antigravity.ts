import { runAgyAcp } from "../agy-acp.js";
import { startAntigravityProbe } from "../antigravity-probe-runner.js";
import { antigravityReading, antigravityTurnReport } from "../antigravity-report.js";
import { forgetAntigravityProbe } from "../antigravity-runtime.js";
import { createAntigravityUsageReader } from "../antigravity-usage-core.js";
import type { ToolAdapter } from "../tool-adapter.js";
import { adapterLaunchCommand } from "../tool-entry.js";
import { defineProviderAdapter } from "./define.js";

export const antigravityAdapter: ToolAdapter = defineProviderAdapter("antigravity", {
  verifySessionSettings: (profile, settings) => {
    if (settings.model !== profile.modelId || settings.effort !== profile.effort) {
      throw new Error(
        `Antigravity did not confirm ${profile.model} with ${profile.effort} thinking. Check the models available to your Google account.`,
      );
    }
  },
  accountUsage: { command: "/usage", parse: antigravityReading, turnReport: antigravityTurnReport },
  usageReader: {
    command: (): readonly string[] => adapterLaunchCommand(antigravityAdapter),
    create: (options) => createAntigravityUsageReader(startAntigravityProbe, options),
    liveSession: true,
  },
  internalSubcommand: "__internal-agy-acp",
  internalSourceFile: "agy-acp.ts",
  internalRunner: runAgyAcp,
  forgetProbe: forgetAntigravityProbe,
  options: { model: "model", effort: "thinking_level", mode: "mode" },
  // Headless stream-json runs unattended; terminal take-over opens `agy` in its normal interactive mode.
  mode: "yolo",
  login: "open",
});
