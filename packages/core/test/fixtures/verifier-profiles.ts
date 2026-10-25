import { DEFAULT_PROFILES } from "../../src/profiles.js";
import type { verifierProfiles } from "../../src/verifier-panel.js";

/** Immutable catalog recipes, with a fresh value snapshot for every preference case. */
export function verifierProfileFixture() {
  const profiles = DEFAULT_PROFILES.map(profile => ({ ...profile })), stage = { profileIds: ["opus-xhigh", "sol-xhigh"] };
  const ids = [...new Set(profiles.map(profile => profile.toolId))];
  const input: Parameters<typeof verifierProfiles>[0] = {
    profiles, tools: ids.map(id => ({ id, status: "ready" })), usable: ids,
    planned: stage.profileIds.map(id => ({ id, toolId: profiles.find(profile => profile.id === id)?.toolId })),
  };
  return { input, stage };
}
