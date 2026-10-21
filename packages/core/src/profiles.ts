import type { AgentProfile, State } from "./model.js";

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
  { id: "astra-ultra", toolId: "codex", model: "GPT-6 Astra", modelId: "gpt-6-astra", effort: "ultra" },
  { id: "sol-ultra", toolId: "codex", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "ultra" },
  { id: "sol-medium", toolId: "codex", model: "GPT-6.1 Sol", modelId: "gpt-6.1-sol", effort: "medium" },
];

/** Native launch settings, independent of display names and profile IDs. */
export const profileConfiguration = (profile: AgentProfile): string => JSON.stringify([profile.toolId, profile.modelId ?? profile.model, profile.effort]);

/** Retain removed definitions for history; only profiles remains available for new work. */
export function restoreProfileCatalog(state: import("./flow.js").DeepMutable<State>, catalog: readonly AgentProfile[] = DEFAULT_PROFILES): void {
  const retired = new Map((state.retiredProfiles ?? []).map(profile => [profile.id, profile]));
  const replacements = new Map<string, string>();
  for (const profile of state.profiles) {
    if (catalog.some(current => current.id === profile.id)) continue;
    const canonical = catalog.find(current => profileConfiguration(current) === profileConfiguration(profile));
    if (!canonical) continue;
    retired.set(profile.id, profile);
    replacements.set(profile.id, canonical.id);
  }
  const replace = (id: string) => replacements.get(id) ?? id;
  for (const routine of state.routines ?? []) routine.profileId = replace(routine.profileId);
  for (const task of state.tasks) {
    if (["done", "cancelled", "pr-open"].includes(task.state)) continue;
    for (const stage of task.plan?.stages.slice(Math.max(0, task.stageIndex)) ?? []) {
      stage.profileIds = stage.profileIds.map(replace);
      if (stage.reviewerProfileIds) stage.reviewerProfileIds = stage.reviewerProfileIds.map(replace);
      for (const assignment of [...stage.assignments ?? [], ...stage.reviewerAssignments ?? []]) assignment.profileId = replace(assignment.profileId);
    }
    for (const product of task.plan?.products ?? []) {
      product.builderProfileId = replace(product.builderProfileId);
      product.reviewerProfileIds = product.reviewerProfileIds.map(replace);
    }
  }
  state.profiles = JSON.parse(JSON.stringify(catalog)) as typeof state.profiles;
  if (retired.size) state.retiredProfiles = [...retired.values()];
}
