import type { Id, Pool, State, Task } from "./model.js";

/** A pool slot in use: which task holds it and on which tool. */
export interface SlotUse {
  taskId: Id;
  toolId: Id;
}

/** A task that could start (or continue) if a slot were free. */
export interface Candidate {
  taskId: Id;
  /** The tool its next agent runs on. */
  toolId: Id;
}

export interface PickInput {
  /** In priority order: tasks already in progress first, then the queue. */
  candidates: readonly Candidate[];
  inUse: readonly SlotUse[];
  pool: Pool;
}

/**
 * Which tasks start now. Pure: the pool limit, the per-tool caps and the order decide.
 * A candidate whose tool is at its cap is skipped, so a lower task on another tool can go.
 */
export function pickStarts({ candidates, inUse, pool }: PickInput): Id[] {
  if (pool.paused) return [];
  let free = pool.limit - inUse.length;
  if (free <= 0) return [];

  const perTool = new Map<Id, number>();
  for (const use of inUse) perTool.set(use.toolId, (perTool.get(use.toolId) ?? 0) + 1);

  const starts: Id[] = [];
  for (const candidate of candidates) {
    if (free === 0) break;
    const cap = pool.toolCaps[candidate.toolId];
    const used = perTool.get(candidate.toolId) ?? 0;
    if (cap !== undefined && used >= cap) continue;
    starts.push(candidate.taskId);
    perTool.set(candidate.toolId, used + 1);
    free -= 1;
  }
  return starts;
}

/** The tasks holding a slot, with the tool their current agent uses. */
export function slotUses(state: State): SlotUse[] {
  const toolOf = new Map(state.profiles.map((profile) => [profile.id, profile.toolId]));
  return state.tasks
    .filter((task) => task.holdsSlot)
    .map((task) => ({ taskId: task.id, toolId: (task.agent && toolOf.get(task.agent.profileId)) ?? "unknown" }));
}

/** The queue in priority order, held tasks included (they show, they just do not start). */
export function queueOf(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.state === "queued").sort((a, b) => a.priority - b.priority);
}

/** How many queued tasks will start as soon as slots allow: the "starts next" line. */
export function startsNextCount(state: State): number {
  if (state.pool.paused) return 0;
  const waiting = state.tasks.filter((task) => task.state === "waiting").length;
  const free = Math.max(0, state.pool.limit - slotUses(state).length - waiting);
  return queueOf(state.tasks).filter((task) => !task.held).slice(0, free).length;
}
