import {
  CATALOG_TOOLS,
  createTaskState,
  DEFAULT_PROFILES,
  DEMO_PRODUCTS,
  displayTask,
  libraryRoles,
  NO_ROLE_CHANGES,
  type DeepMutable,
  type State,
  type Task,
} from "@petrina/core";

/** Private catalog data, without running the demo's workflows or generating their history. */
export function stateFixture(now = 1_000_000_000, extra: Partial<State> = {}): DeepMutable<State> {
  return structuredClone({
    now,
    seq: 0,
    products: DEMO_PRODUCTS,
    roles: libraryRoles(NO_ROLE_CHANGES),
    profiles: DEFAULT_PROFILES,
    tools: [...CATALOG_TOOLS],
    tasks: [],
    inbox: [],
    pool: { limit: 5, paused: true, toolCaps: { "claude-code": 3, codex: 2 } },
    planner: "sonnet-medium",
    ...extra,
  } satisfies State) as DeepMutable<State>;
}

/** Components receive the production display shape, never an engine repository cursor. */
export function taskFixture(state: Pick<State, "products" | "now">, extra: Partial<Task> = {}): DeepMutable<Task> {
  const task = createTaskState({ productId: extra.productId ?? state.products[0]!.id, title: extra.title ?? "Fixture request", backlog: true }, state.products,
    { id: extra.id ?? "task", timelineId: "created", now: state.now, priority: 0 });
  return structuredClone({ ...displayTask(task), ...extra }) as DeepMutable<Task>;
}

export function oneTaskFixture(now = 1_000_000_000): DeepMutable<State> {
  const state = stateFixture(now);
  state.tasks = [taskFixture(state, { state: "running", column: "building", holdsSlot: true, startedAt: now - 1_000,
    plan: { rationale: "Build and review the request", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
      { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
    ] }, stageIndex: 0,
  })];
  return state;
}

/** Explicit reports for usage presentation; no simulated turns are needed to draw a meter. */
export function usageFixture(now = 1_000_000_000): DeepMutable<State> {
  const state = stateFixture(now);
  state.tools = state.tools.filter(tool => tool.id === "claude-code" || tool.id === "codex");
  state.pool.usage = [
    { toolId: "claude-code", kind: "seven_day", status: "allowed", utilization: 0.62, resetsAt: now + 3 * 86_400_000, at: now },
    { toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0.35, resetsAt: now + 90 * 60_000, at: now },
    { toolId: "codex", kind: "codex:primary", status: "allowed", utilization: 0.84, windowMinutes: 10_080, resetsAt: now + 2 * 86_400_000, at: now },
  ];
  return state;
}
