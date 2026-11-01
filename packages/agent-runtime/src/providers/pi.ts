import { steering } from "../live-input.js";
import { runPiAcp } from "../pi-acp.js";
import { defineProviderAdapter } from "./define.js";

export const piAdapter = defineProviderAdapter("pi", {
  liveInput: steering(false),
  internalSubcommand: "__internal-pi-acp",
  internalSourceFile: "pi-acp.ts",
  internalRunner: runPiAcp,
  options: { model: "model", effort: "thinking_level", mode: "mode" },
  mode: "auto",
  login: "open",
});
