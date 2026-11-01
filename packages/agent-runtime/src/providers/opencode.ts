import { defineProviderAdapter } from "./define.js";

export const OPENCODE_AGENT_COMMAND = ["opencode", "acp"] as const;

export const opencodeAdapter = defineProviderAdapter("opencode", {
  command: OPENCODE_AGENT_COMMAND,
  options: { model: "model", effort: "effort", mode: "mode" },
  mode: "build",
  login: "open",
});
