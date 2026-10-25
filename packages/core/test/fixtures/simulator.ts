import type { State, Stage, Task } from '../../src/model.js';
import { Simulator } from '../../src/sim.js';
import { stateFixture } from './state.js';

export function emptyState(limit = 2): State { return stateFixture({ now: 0, products: [{ id: 'p', name: 'Product', repo: 'acme/product', tone: 'blue' }], pool: { limit, paused: false, toolCaps: {} } }); }

export function task(sim: Simulator, id: string): Task {
  const found = sim.getState().tasks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

export function runUntil(sim: Simulator, done: () => boolean, limit = 300): void {
  for (let tick = 0; tick < limit && !done(); tick += 1) {
    sim.tick();
    for (const item of sim.getState().inbox) {
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
  }
}

export function disagreeing(kind: Task['kind'] = 'feature', limit = 2): { sim: Simulator; id: string } {
  const key = kind + ':' + limit;
  let recipe = disagreementRecipes.get(key);
  if (!recipe) {
    const seed = new Simulator(emptyState(limit), { prMergeAfter: 1_000 });
    const id = seed.addTask({ productId: 'p', title: 'Saved carts', kind });
    const sim = new Simulator(seed.getState(), { prMergeAfter: 1_000, disagree: [id] });
    for (let tick = 0; tick < 300 && !inboxItem(sim, 'disagreement'); tick += 1) sim.tick();
    if (!inboxItem(sim, 'disagreement')) throw new Error('the architects never disagreed');
    recipe = { id, state: JSON.stringify(sim.getState()) };
    disagreementRecipes.set(key, recipe);
  }
  // The cached value is text only. Every case owns all writable state and a new private work log.
  return { id: recipe.id, sim: new Simulator(JSON.parse(recipe.state) as State, { prMergeAfter: 1_000, disagree: [recipe.id] }) };
}

export function reshaped(sim: Simulator, id: string, reshape: (stages: Stage[], design: number) => Stage[]): Simulator {
  const state = JSON.parse(JSON.stringify(sim.getState())) as { tasks: { id: string; stageIndex: number; plan: { stages: Stage[] } }[] };
  const draft = state.tasks.find((entry) => entry.id === id)!;
  draft.plan.stages = reshape(draft.plan.stages, draft.stageIndex);
  return new Simulator(state as unknown as State, { prMergeAfter: 1_000, disagree: [id] });
}

export function inboxItem(sim: Simulator, kind: string) {
  return sim.getState().inbox.find((item) => item.kind === kind);
}

export function tickUntil(sim: Simulator, kind: string, limit = 300) {
  for (let tick = 0; tick < limit && !inboxItem(sim, kind); tick += 1) sim.tick();
  const item = inboxItem(sim, kind);
  if (!item) throw new Error(`no ${kind} item`);
  return item;
}

export const reviewerRuns = (task: Task) => task.timeline.filter((entry) => entry.roleId === "design-reviewer" && entry.tone === "milestone").length;
/** Earlier design rounds are unrelated setup for the design-call variant matrices. */
const disagreementRecipes = new Map<string, { id: string; state: string }>();
