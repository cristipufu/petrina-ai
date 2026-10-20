import type { AgentProfile } from "./model.js";

export const DEFAULT_PROFILES: readonly AgentProfile[] = [
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
  // Keep the engine's existing stand-in preferences ahead of profiles retained from the demos.
  { id: "sonnet-medium", toolId: "claude-code", model: "Sonnet 5.5", modelId: "sonnet", effort: "medium" },
  { id: "codex-xhigh", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh" },
  { id: "codex-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
  { id: "astra-ultra", toolId: "codex", model: "GPT-6 Astra", modelId: "gpt-6-astra", effort: "ultra" },
  { id: "sol-ultra", toolId: "codex", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "ultra" },
  { id: "sol-medium", toolId: "codex", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "medium" },
];
