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
  if (state.profileCatalogSaved) return;
  state.profileCatalogSaved = true;
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


/** Native choices for one selected model; models are reported by the installed harness. */
export interface ProfileChoices {
  toolId: string;
  models: readonly { id: string; name: string }[];
  modelId: string;
  efforts: readonly AgentProfile["effort"][];
}
export interface ProfileDraft { toolId: string; modelId: string; effort: AgentProfile["effort"]; standby?: boolean }

export function profileModelName(profile: Pick<AgentProfile, "toolId" | "modelId" | "model">): string {
  if (profile.toolId === "codex") {
    if (profile.modelId === "gpt-6.1-sol") return "GPT-6.1 Sol";
    if (profile.modelId === "gpt-6-astra") return "GPT-6 Astra";
  }
  return profile.model;
}

/** Protect future repair paths as well as currently running seats. History keeps its own definition. */
export function profileReferences(state: Pick<State, "tasks" | "routines" | "backgroundAgents">, id: string): string[] {
  const tasks = state.tasks.filter(task => !["done", "cancelled", "pr-open"].includes(task.state) && (
    task.maintenance?.profile.id === id || task.agent?.profileId === id || task.helpers?.some(agent => agent.profileId === id) ||
    (task.repositories ?? (task.repository ? [task.repository] : [])).some(work => work.conversation?.profileId === id || work.builderSession?.profileId === id) ||
    task.plan?.stages.some(stage => [...stage.profileIds, ...stage.reviewerProfileIds ?? []].includes(id)) ||
    task.plan?.products?.some(product => product.builderProfileId === id || product.reviewerProfileIds.includes(id))
  )).map(task => `task “${task.title}”`);
  return [...tasks, ...(state.backgroundAgents ?? []).filter(agent => agent.profileId === id).map(agent => agent.label), ...(state.routines ?? []).filter(routine => routine.profileId === id).map(routine => `routine “${routine.name}”`)];
}

export function assertProfileUnused(state: Pick<State, "tasks" | "routines" | "backgroundAgents">, id: string): void {
  const references = profileReferences(state, id);
  if (references.length) throw new Error(`Reassign ${references.slice(0, 3).join(", ")}${references.length > 3 ? ` and ${references.length - 3} more` : ""} before changing this profile.`);
}

export function saveProfile(state: import("./flow.js").DeepMutable<State>, draft: ProfileDraft, choices: ProfileChoices, id: string, previousId?: string): string {
  const previous = previousId ? state.profiles.find(profile => profile.id === previousId) : undefined;
  const same = (profile: AgentProfile) => profileConfiguration(profile) === JSON.stringify([draft.toolId, draft.modelId, draft.effort]) && Boolean(profile.standby) === Boolean(draft.standby);
  // A lost reply can be retried with the same supplied identity, including a versioned edit.
  const existing = state.profiles.find(profile => profile.id === id);
  if (existing && same(existing) && (!previousId || previousId === id || state.retiredProfiles?.some(profile => profile.id === previousId))) return existing.id;
  if (previousId && !previous) throw new Error("This profile was removed. Reopen the profile list.");
  if (previous && same(previous)) return previous.id;
  if (previous) assertProfileUnused(state, previous.id);
  const model = choices.models.find(model => model.id === draft.modelId);
  if (choices.toolId !== draft.toolId || choices.modelId !== draft.modelId || !model || !choices.efforts.includes(draft.effort)) throw new Error("Choose a model and effort supported by this tool. Refresh its choices and try again.");
  if (existing || state.retiredProfiles?.some(profile => profile.id === id)) throw new Error("This profile identity is already used. Reopen the editor.");
  if (state.profiles.some(profile => profile.id !== previousId && profileConfiguration(profile) === JSON.stringify([draft.toolId, draft.modelId, draft.effort]))) throw new Error("A profile with this tool, model and effort already exists.");
  if (draft.standby && !state.profiles.some(profile => profile.id !== previousId && !profile.standby)) throw new Error("Keep at least one profile available to the planner.");
  const next: AgentProfile = { id, toolId: draft.toolId, modelId: model.id, model: profileModelName({ toolId: draft.toolId, modelId: model.id, model: model.name }), effort: draft.effort, ...(draft.standby ? { standby: true } : {}) };
  if (previous) {
    state.retiredProfiles = [...state.retiredProfiles ?? [], previous];
    state.profiles = state.profiles.filter(profile => profile.id !== previousId);
  }
  state.profiles.push(next);
  state.profileCatalogSaved = true;
  return next.id;
}

export function removeProfile(state: import("./flow.js").DeepMutable<State>, id: string): void {
  const profile = state.profiles.find(profile => profile.id === id);
  if (!profile) return;
  assertProfileUnused(state, id);
  if (!state.profiles.some(other => other.id !== id && !other.standby)) throw new Error("Keep at least one profile available to the planner.");
  state.retiredProfiles = [...state.retiredProfiles ?? [], profile];
  state.profiles = state.profiles.filter(other => other.id !== id);
  state.profileCatalogSaved = true;
}

/** Scripted native capabilities, not guesses used by the real engine. */
export function demoProfileChoices(toolId: string, modelId?: string): ProfileChoices {
  const profiles = DEFAULT_PROFILES.filter(profile => profile.toolId === toolId);
  const models = [...new Map(profiles.map(profile => [profile.modelId!, { id: profile.modelId!, name: profileModelName(profile) }])).values()];
  const selected = modelId ?? models[0]?.id ?? "";
  return { toolId, models, modelId: selected, efforts: [...new Set([...profiles.filter(profile => profile.modelId === selected).map(profile => profile.effort), ...(toolId === "claude-code" ? ["medium" as const] : [])])] };
}
