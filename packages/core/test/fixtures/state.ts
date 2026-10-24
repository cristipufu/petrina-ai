import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../src/library.js";
import { createTaskState } from "../../src/task-transitions.js";
import type { DeepMutable } from "../../src/flow.js";
import type { State, Task } from "../../src/model.js";

/** Fresh rule/simulator data, with no scripted demo tasks, clock, accounts or native effects. */
export function stateFixture(extra: Partial<State> = {}): DeepMutable<State> {
  const state = { now: 1_000_000_000, seq: 0, products: [
    { id: "shop", name: "Shop", repo: "local/shop", tone: "blue" },
    { id: "billing", name: "Billing", repo: "local/billing", tone: "green" },
  ], tasks: [], inbox: [], roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS,
  pool: { limit: 3, paused: true, toolCaps: {} }, ...extra } satisfies State;
  return JSON.parse(JSON.stringify(state)) as DeepMutable<State>;
}

/** Use the production initializer; a case adds only the state its subject needs. */
export function taskFixture(state: Pick<State, "products" | "now">, extra: Partial<Task> = {}): DeepMutable<Task> {
  const productId = extra.productId ?? state.products[0]?.id;
  if (!productId) throw new Error("Give this task fixture a registered product.");
  const task = createTaskState({ productId, title: extra.title ?? "Fixture request", backlog: true }, state.products,
    { id: extra.id ?? "task", timelineId: "created", now: state.now, priority: 0 });
  return JSON.parse(JSON.stringify({ ...task, ...extra })) as DeepMutable<Task>;
}
