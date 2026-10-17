import type { Id, Pool, State, Task } from "./model.js";
import { byRoom, headroom, toolCapNow } from "./usage.js";

/** A pool slot in use: which task holds it, on which tool, and the agent in it when there is one. */
export interface SlotUse {
  taskId: Id;
  toolId: Id;
  roleId?: Id;
  profileId?: Id;
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
  /** The time, for the usage reports that slow a tool down. Default: now. */
  now?: number;
}

/**
 * Which tasks start now. Pure: the pool limit, the per-tool caps and the order decide.
 * A candidate whose tool is at its cap is skipped, so a lower task on another tool can go.
 * A tool past the slow-down mark of a usage window has half its cap for new agents (`toolCapNow`).
 */
export function pickStarts({ candidates, inUse, pool, now = Date.now() }: PickInput): Id[] {
  if (pool.paused) return [];
  let free = pool.limit - inUse.length;
  if (free <= 0) return [];

  const perTool = new Map<Id, number>();
  for (const use of inUse) perTool.set(use.toolId, (perTool.get(use.toolId) ?? 0) + 1);

  const starts: Id[] = [];
  for (const candidate of candidates) {
    if (free === 0) break;
    const cap = toolCapNow(pool, candidate.toolId, now);
    const used = perTool.get(candidate.toolId) ?? 0;
    if (cap !== undefined && used >= cap) continue;
    starts.push(candidate.taskId);
    perTool.set(candidate.toolId, used + 1);
    free -= 1;
  }
  return starts;
}

/**
 * Candidates with those on the tool that has more of its limit left first (see `headroom`), so when the pool
 * cannot take them all, the slots go to the tool with the most room. Candidates on one tool keep their order.
 */
export function balanced(candidates: readonly Candidate[], pool: Pool, now: number): Candidate[] {
  return byRoom(candidates, (candidate) => headroom(pool, { toolId: candidate.toolId }, now));
}

/** The slots in use: one per task holding a slot, and one more for each agent working beside its main one. */
export function slotUses(state: State): SlotUse[] {
  const toolOf = new Map(state.profiles.map((profile) => [profile.id, profile.toolId]));
  return state.tasks
    .filter((task) => task.holdsSlot)
    .flatMap((task) => [
      { taskId: task.id, toolId: (task.agent && toolOf.get(task.agent.profileId)) ?? "unknown", ...(task.agent ? { roleId: task.agent.roleId, profileId: task.agent.profileId } : {}) },
      ...(task.helpers ?? []).map((helper) => ({ taskId: task.id, toolId: toolOf.get(helper.profileId) ?? "unknown", roleId: helper.roleId, profileId: helper.profileId })),
    ]);
}

/** Whether a task that already holds its slot may start one more agent on this tool now: every slot in use counts. */
export function extraSlot(state: State, toolId: Id): boolean {
  if (state.pool.paused) return false;
  const uses = slotUses(state);
  if (uses.length >= state.pool.limit) return false;
  const cap = toolCapNow(state.pool, toolId, state.now);
  return cap === undefined || uses.filter((use) => use.toolId === toolId).length < cap;
}

/** What a task waits for when its tool slows down near a usage limit. */
export const FEWER_START = "fewer start on it this close to its limit";

/** Rechecked for every agent, including one on the same tool. The task's old slot does not count. */
export function slotWait(state: State, candidate: Candidate): string | undefined {
  const others = slotUses(state).filter((use) => use.taskId !== candidate.taskId);
  if (state.pool.paused) return "Waiting for the pool to resume";
  if (others.length >= state.pool.limit) return "Waiting for a free slot";
  const cap = toolCapNow(state.pool, candidate.toolId, state.now);
  if (cap !== undefined && others.filter((use) => use.toolId === candidate.toolId).length >= cap) {
    const tool = state.tools.find((entry) => entry.id === candidate.toolId)?.name ?? candidate.toolId;
    // Fewer seats than the cap says: the tool is slowing down, and the task says so.
    const held = cap !== state.pool.toolCaps[candidate.toolId];
    return `Waiting for a free ${tool} slot${held ? ` (${FEWER_START})` : ""}`;
  }
  return undefined;
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
