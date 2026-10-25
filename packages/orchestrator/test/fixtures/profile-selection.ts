import { BUILT_IN_ROLES, DEFAULT_PROFILES, CHECK_NAMES, type CheckId, createTaskState, roleForTask, usableAgentTools, type AgentProfile, type DeepMutable, type State } from "@petrina/core";
import { ProfileSelection, type ProfileSelectionHost } from "../../src/profile-selection.js";
import { restoreRepositoryState, taskView } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";

/** Private catalog observations; the actual selector owns all decisions and caches. */
export function profileSelectionFixture() {
  let now = 1_000_000_000;
  const state: DeepMutable<State> & { tasks: RuntimeTask[] } = JSON.parse(JSON.stringify({ now, seq: 0,
    products: [{ id: "product", name: "Product", repo: "a/b", tone: "blue", delivery: "local", approveDelivery: true }],
    tasks: [], inbox: [], profiles: DEFAULT_PROFILES, roles: BUILT_IN_ROLES,
    tools: [...new Set(DEFAULT_PROFILES.map(profile => profile.toolId))].map(id => ({ id, name: CHECK_NAMES[id as CheckId] ?? id, command: [], models: [], status: "ready" as const })), pool: { limit: 3, paused: true, toolCaps: {} },
    setup: { done: true, platform: "linux", checks: [] },
  }));
  const task: RuntimeTask = createTaskState({ productId: "product", title: "Build", backlog: true }, state.products,
    { id: "task", timelineId: "created", now, priority: 0 });
  restoreRepositoryState(task); state.tasks.push(task);
  const profile = (id: string): AgentProfile | undefined => state.profiles.find(profile => profile.id === id) ?? state.retiredProfiles?.find(profile => profile.id === id);
  const adapterIds = new Set(state.profiles.map(profile => profile.toolId));
  const unexpected = (name: string): never => { throw new Error('Unexpected selection observation: ' + name); };
  const host: ProfileSelectionHost = {
    current: () => state, activeState: () => state,
    profile, role: (id, task) => roleForTask(state.roles, id, task),
    profileName: id => profile(id)?.model ?? id, toolName: id => state.tools.find(tool => tool.id === id)?.name ?? id ?? "the tool",
    usableTools: () => usableAgentTools(state.setup?.checks), onUsable: id => profile(id) ? id : unexpected('fallback ' + id),
    hasToolAdapter: id => adapterIds.has(id),
    awayFromBuilder: role => ["build", "delivery", "votes"].includes(role.result) ? false : unexpected('role capability ' + role.id),
    notReady: status => status === "not-installed" || status === "logged-out",
    now: () => now, readinessAllowanceMs: () => 11_000, capacityRetryCount: () => 3,
    capacityWaiting: () => unexpected('model capacity words'), digest: serialized => serialized,
    completedDesignAuthor: () => unexpected('completed design author'), reportedReviewerTools: () => unexpected('legacy reviewer tools'),
  };
  return { state, task, host, profile, selection: new ProfileSelection(host), now: () => now, advance: (ms: number) => { now += ms; },
    snapshot: (): State => ({ ...state, tasks: state.tasks.map(task => taskView(task)) }),
  };
}
